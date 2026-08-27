/**
 * Runtime sprite loading for species that are NOT among the 42 bundled in
 * assets/showdown/ (Phase 3 §2). Fetches and disk-caching happen in the main
 * process (`spriteCache.ts`) behind IPC — the renderer's CSP allows no network
 * connect-src; decoding the GIF and re-encoding it as a coalesced PNG sheet
 * happens HERE, because that needs a DOM canvas main does not have.
 *
 * Species-agnostic: this module only knows how to turn a Showdown gen5ani
 * id into art. Line/stage/evolvesTo/locomotion come from `dexData.ts`.
 */
import { decompressFrames, parseGIF, type ParsedFrame } from 'gifuct-js';
import { Texture } from 'pixi.js';
import type { CachedSprite, LazySpriteMeta, SpriteView } from '@shared/types';
import type { FrameSet, PokemonAnimation } from './showdownArt';
import { pokeballFrameSet } from './showdownArt';
import { frameRect, sliceFrames } from './spriteSheet';
import { speciesEntry } from './dexData';
import { loadPixelTexture } from './imageTexture';

/** A sheet row may not exceed this many pixels wide (the bundled Blastoise
 *  sheet hit 10010px, which is exactly the mistake this guards against). */
const MAX_SHEET_WIDTH = 8192;

/** One in-flight or resolved fetch per (id, view), so a thumbnail request and
 *  a later full pick of the same species never fetch twice, and two callers
 *  racing the same species share one decode. */
const viewCache = new Map<string, Promise<FrameSet | null>>();
const animationCache = new Map<string, Promise<PokemonAnimation | null>>();
const thumbnailCache = new Map<string, Promise<string | null>>();

/** Composite a GIF's frames into full, disposal-correct images, matching how
 *  the bundled sheets were produced (see assets/ASSETS.md): each output frame
 *  is a complete picture, not a raw delta patch.
 *
 * Standard algorithm (frame-owns-its-own-disposal): draw each frame's patch
 * onto a persistent canvas, snapshot the FULL canvas as that frame's image,
 * THEN apply that frame's disposal in preparation for the next one. Disposal
 * types: 0/1 leave the canvas as drawn; 2 clears the frame's own rect back to
 * transparent; 3 restores whatever the canvas looked like before this frame
 * was drawn. */
function coalesceGif(frames: ParsedFrame[], width: number, height: number): { canvas: HTMLCanvasElement; durations: number[] }[] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const patchCanvas = document.createElement('canvas');
  const patchCtx = patchCanvas.getContext('2d')!;

  let savedForRestore: ImageData | null = null;
  const out: { canvas: HTMLCanvasElement; durations: number[] }[] = [];

  for (const frame of frames) {
    const { dims, patch, disposalType, delay } = frame;

    if (disposalType === 3) {
      savedForRestore = ctx.getImageData(0, 0, width, height);
    }

    patchCanvas.width = dims.width;
    patchCanvas.height = dims.height;
    patchCtx.putImageData(new ImageData(new Uint8ClampedArray(patch), dims.width, dims.height), 0, 0);
    ctx.drawImage(patchCanvas, dims.left, dims.top);

    const snapshot = document.createElement('canvas');
    snapshot.width = width;
    snapshot.height = height;
    snapshot.getContext('2d')!.drawImage(canvas, 0, 0);
    out.push({ canvas: snapshot, durations: [delay || 100] });

    if (disposalType === 2) {
      ctx.clearRect(dims.left, dims.top, dims.width, dims.height);
    } else if (disposalType === 3 && savedForRestore) {
      ctx.putImageData(savedForRestore, 0, 0);
    }
  }

  return out;
}

/** Lay coalesced frames into one sheet canvas, wrapping rows once a single row
 *  would exceed MAX_SHEET_WIDTH, and return it plus the geometry to cache. */
function buildSheet(
  frames: { canvas: HTMLCanvasElement; durations: number[] }[],
  frameWidth: number,
  frameHeight: number
): { sheet: HTMLCanvasElement; meta: Omit<LazySpriteMeta, 'durations'> & { durations: number[] } } {
  const columns = Math.max(1, Math.min(frames.length, Math.floor(MAX_SHEET_WIDTH / frameWidth)));
  const rows = Math.ceil(frames.length / columns);

  const sheet = document.createElement('canvas');
  sheet.width = columns * frameWidth;
  sheet.height = rows * frameHeight;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const durations: number[] = [];
  frames.forEach((f, i) => {
    const rect = frameRect({ frameWidth, frameHeight, frameCount: frames.length, columns }, i);
    ctx.drawImage(f.canvas, rect.x, rect.y);
    durations.push(f.durations[0]);
  });

  return { sheet, meta: { frameWidth, frameHeight, frameCount: frames.length, columns, rows, durations } };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('canvas.toBlob produced no data'));
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

function frameSetFromSheet(meta: LazySpriteMeta, source: Texture | HTMLCanvasElement): FrameSet {
  const texture = source instanceof Texture ? source : Texture.from(source);
  texture.source.scaleMode = 'nearest';
  const textures = sliceFrames(texture, meta);
  return {
    frameWidth: meta.frameWidth,
    frameHeight: meta.frameHeight,
    frames: textures.map((t, i) => ({ texture: t, time: meta.durations[i] }))
  };
}

async function fetchAndDecode(id: string, view: SpriteView): Promise<{ sheet: HTMLCanvasElement; meta: LazySpriteMeta } | null> {
  const gifBytes = await window.api.fetchSpriteGif(id, view);
  if (!gifBytes) return null;
  const gif = parseGIF(gifBytes);
  const frames = decompressFrames(gif, true);
  if (frames.length === 0) return null;
  const coalesced = coalesceGif(frames, gif.lsd.width, gif.lsd.height);
  const { sheet, meta } = buildSheet(coalesced, gif.lsd.width, gif.lsd.height);
  return { sheet, meta };
}

/** One view (front or back) of one species: cache-hit from disk, or fetch +
 *  decode + cache-write. Returns null when the species has no such sprite at
 *  all (a real 404 — most species have no back-view alternate, which is
 *  expected, not an error) or the fetch failed outright (offline).
 *
 * `evictOnNull` (default true, for the front view a walker actually needs)
 * drops a failed lookup from the cache immediately so the NEXT pick of the
 * same species retries the network instead of remembering the failure
 * forever. The back view is left cached even on failure: most species
 * genuinely have none, and that fact doesn't change between picks. */
async function loadView(id: string, view: SpriteView, evictOnNull = true): Promise<FrameSet | null> {
  const key = `${id}:${view}`;
  const existing = viewCache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<FrameSet | null> => {
    const cached: CachedSprite | null = await window.api.getCachedSprite(id, view);
    if (cached) {
      const texture = await loadPixelTexture(URL.createObjectURL(new Blob([cached.png], { type: 'image/png' })));
      return frameSetFromSheet(cached.meta, texture);
    }

    const decoded = await fetchAndDecode(id, view);
    if (!decoded) return null;

    const frameSet = frameSetFromSheet(decoded.meta, decoded.sheet);
    // Cache write is fire-and-forget: the walker doesn't need to wait on disk
    // I/O, and a failed write (e.g. disk full) shouldn't break the pick.
    void canvasToPng(decoded.sheet)
      .then((png) => window.api.saveCachedSprite(id, view, png, decoded.meta))
      .catch((err) => console.error(`[lazySprites] ${id}: failed to cache ${view} sheet —`, err));
    return frameSet;
  })();

  viewCache.set(key, promise);
  if (evictOnNull) {
    void promise.then((result) => {
      if (result === null) viewCache.delete(key);
    });
  }
  return promise;
}

/** Full animation for a lazily-loaded species: front required, back
 *  best-effort. Returns null only when the front view could not be obtained
 *  at all (offline/404) — the caller shows a pokeball and a toast. */
export function loadLazyAnimation(id: string): Promise<PokemonAnimation | null> {
  const existing = animationCache.get(id);
  if (existing) return existing;

  const promise = (async (): Promise<PokemonAnimation | null> => {
    const entry = speciesEntry(id);
    if (!entry) return null;
    const front = await loadView(id, 'front');
    if (!front) return null;
    const back = await loadView(id, 'back', false).catch(() => null);
    return {
      info: {
        name: entry.id,
        dex: entry.num,
        label: entry.name,
        locomotion: entry.locomotion,
        frameWidth: front.frameWidth,
        frameHeight: front.frameHeight,
        sheetUrl: '',
        line: entry.line,
        stage: entry.stage,
        evolvesTo: entry.evolvesTo,
        hasBack: !!back
      },
      front,
      back: back ?? undefined
    };
  })();

  animationCache.set(id, promise);
  void promise.then((result) => {
    if (result === null) animationCache.delete(id);
  });
  return promise;
}

/** Pokeball stand-in, shown the instant a lazy species is chosen while its
 *  real art is still loading (or failed to load at all). */
export function placeholderAnimation(id: string): PokemonAnimation {
  const entry = speciesEntry(id);
  const front = pokeballFrameSet();
  return {
    info: {
      name: id,
      dex: entry?.num ?? 0,
      label: entry?.name ?? id,
      locomotion: entry?.locomotion ?? 'walk',
      frameWidth: front.frameWidth,
      frameHeight: front.frameHeight,
      sheetUrl: '',
      line: entry?.line ?? id,
      stage: entry?.stage ?? 1,
      evolvesTo: entry?.evolvesTo ?? [],
      hasBack: false
    },
    front
  };
}

/** Small concurrency gate so a page of search results doesn't fire 30 fetches
 *  at once — only `limit` thumbnail loads run at a time, the rest queue. */
function makeGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= limit || queue.length === 0) return;
    active++;
    queue.shift()!();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

const thumbnailGate = makeGate(4);

/** A single still frame of a lazy species, as an object URL, for the picker's
 *  search results. Cheap: reuses the same decode/cache as the full walker (a
 *  hit here means a later pick needs no further network). */
export function loadLazyThumbnail(id: string): Promise<string | null> {
  const existing = thumbnailCache.get(id);
  if (existing) return existing;

  const promise = thumbnailGate(async (): Promise<string | null> => {
    const front = await loadView(id, 'front');
    if (!front) return null;
    const frame = front.frames[0]?.texture;
    if (!frame) return null;
    // Frame 0 is always at the sheet's top-left, whatever row layout the
    // full sheet wrapped into — its own Texture#frame already knows that.
    const canvas = document.createElement('canvas');
    canvas.width = front.frameWidth;
    canvas.height = front.frameHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      frame.source.resource as CanvasImageSource,
      frame.frame.x,
      frame.frame.y,
      frame.frame.width,
      frame.frame.height,
      0,
      0,
      front.frameWidth,
      front.frameHeight
    );
    return canvas.toDataURL('image/png');
  });

  thumbnailCache.set(id, promise);
  void promise.then((result) => {
    if (result === null) thumbnailCache.delete(id);
  });
  return promise;
}
