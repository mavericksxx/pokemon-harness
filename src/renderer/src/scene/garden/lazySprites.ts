/**
 * Runtime sprite loading for species that are NOT among the 42 bundled in
 * assets/showdown/ (Phase 3 §2). Fetches and disk-caching happen in the main
 * process (`spriteCache.ts`) behind IPC — the renderer's CSP allows no network
 * connect-src; decoding the art and re-encoding it as a coalesced PNG sheet
 * happens HERE, because that needs a DOM canvas main does not have.
 *
 * Two art kinds, both ending up as the same `FrameSet` shape (Phase 6 §1/§3):
 * species #1-649 fetch an animated gen5ani GIF and get coalesced frame-by-
 * frame (`fetchAndDecode`); species #650-1025 (`dexData.ts`'s `static: true`)
 * fetch a single Smogon Sprite Project PNG and get wrapped as a 1-frame sheet
 * (`fetchAndDecodeStatic`) — no animation, but otherwise identical to the
 * consumer (`WalkerSprite`'s bob/mirror/shadow treatment doesn't care how
 * many frames a sheet has). Line/stage/evolvesTo/locomotion come from
 * `dexData.ts` either way.
 *
 * Phase 5 §2 (shiny): every fetch/decode/cache function here takes a `shiny`
 * flag threaded straight through to `window.api.fetchSpriteGif`/
 * `getCachedSprite`/`saveCachedSprite` (whose cache keys already distinguish
 * shiny — see spriteCache.ts). Bundled species have no local shiny sheets at
 * all, so a shiny pick ALWAYS comes through this lazy path, even for one of
 * the 42 bundled species — see GardenScene's `resolveAnimation`. If a shiny
 * FRONT sheet 404s, `loadLazyAnimation` falls back to the normal front sheet
 * (logged) rather than showing a pokeball forever; a shiny BACK sheet 404
 * (most species genuinely lack a shiny-specific back distinct from front's
 * fallback) just leaves `back` undefined, same as the existing "some species
 * have no back view at all" case — falling back to a normal-palette back
 * would give one walker two palettes depending on facing.
 */
import { decompressFrame, decompressFrames, parseGIF, type ParsedFrame } from 'gifuct-js';
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

/** One in-flight or resolved fetch per (id, view), so a full pick (walker or
 *  evolution) of the same species never fetches or decodes its sheet twice,
 *  and two callers racing the same species share one decode. A picker
 *  THUMBNAIL preview does not go through this cache — see
 *  `decodeThumbnailFrame` below — so merely browsing the dex can't fill it
 *  with species nobody ever picked. */
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

async function fetchAndDecode(
  id: string,
  view: SpriteView,
  shiny: boolean
): Promise<{ sheet: HTMLCanvasElement; meta: LazySpriteMeta } | null> {
  const gifBytes = await window.api.fetchSpriteGif(id, view, shiny);
  if (!gifBytes) return null;
  const gif = parseGIF(gifBytes);
  const frames = decompressFrames(gif, true);
  if (frames.length === 0) return null;
  const coalesced = coalesceGif(frames, gif.lsd.width, gif.lsd.height);
  const { sheet, meta } = buildSheet(coalesced, gif.lsd.width, gif.lsd.height);
  return { sheet, meta };
}

/** How long a static species' single frame "holds" — never advances, so the
 *  value is arbitrary, but AnimatedSprite's FrameObject shape wants one. */
const STATIC_FRAME_MS = 1000;

/**
 * Species #650-1025 (Phase 6 §1): no gen5ani animation exists, so their art
 * is a single static PNG (Smogon Sprite Project's Gen-5-style set,
 * `gen5`/`gen5-back`) rather than a GIF to decode. `fetchSpriteGif` (shared
 * IPC call, name predates statics — see `spriteCache.ts`) already returns the
 * right bytes for either kind; this just skips the GIF-specific decode and
 * wraps the single image as a 1-frame sheet, so everything downstream
 * (`frameSetFromSheet`, the cache write, `WalkerSprite`'s bob/mirror/shadow)
 * treats it exactly like an animated sheet that happens to have one frame. */
async function fetchAndDecodeStatic(
  id: string,
  view: SpriteView,
  shiny: boolean
): Promise<{ sheet: HTMLCanvasElement; meta: LazySpriteMeta } | null> {
  const pngBytes = await window.api.fetchSpriteGif(id, view, shiny);
  if (!pngBytes) return null;
  const blobUrl = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));
  try {
    const texture = await loadPixelTexture(blobUrl);
    const { width, height } = texture;
    if (width <= 0 || height <= 0) return null;
    const sheet = document.createElement('canvas');
    sheet.width = width;
    sheet.height = height;
    const ctx = sheet.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(texture.source.resource as CanvasImageSource, 0, 0);
    return {
      sheet,
      meta: { frameWidth: width, frameHeight: height, frameCount: 1, columns: 1, rows: 1, durations: [STATIC_FRAME_MS] }
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
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
async function loadView(id: string, view: SpriteView, shiny: boolean, evictOnNull = true): Promise<FrameSet | null> {
  const key = `${id}:${view}:${shiny ? 'shiny' : 'normal'}`;
  const existing = viewCache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<FrameSet | null> => {
    const cached: CachedSprite | null = await window.api.getCachedSprite(id, view, shiny);
    if (cached) {
      const texture = await loadPixelTexture(URL.createObjectURL(new Blob([cached.png], { type: 'image/png' })));
      return frameSetFromSheet(cached.meta, texture);
    }

    const decoded = speciesEntry(id)?.static
      ? await fetchAndDecodeStatic(id, view, shiny)
      : await fetchAndDecode(id, view, shiny);
    if (!decoded) return null;

    const frameSet = frameSetFromSheet(decoded.meta, decoded.sheet);
    // Cache write is fire-and-forget: the walker doesn't need to wait on disk
    // I/O, and a failed write (e.g. disk full) shouldn't break the pick.
    void canvasToPng(decoded.sheet)
      .then((png) => window.api.saveCachedSprite(id, view, shiny, png, decoded.meta))
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

/** `loadView`, plus the shiny-specific fallback: a shiny FRONT 404 falls back
 *  to the normal front sheet (logged) rather than leaving the walker on a
 *  pokeball forever. Non-shiny calls, and the back view, pass straight
 *  through with no fallback — see this file's header for why the back view
 *  doesn't get one. */
async function loadFrontWithShinyFallback(id: string, shiny: boolean): Promise<FrameSet | null> {
  const primary = await loadView(id, 'front', shiny);
  if (primary || !shiny) return primary;
  console.error(`[lazySprites] ${id}: shiny front sprite unavailable — falling back to normal`);
  return loadView(id, 'front', false);
}

/** Full animation for a lazily-loaded species: front required (falling back
 *  from shiny to normal on a 404 — see loadFrontWithShinyFallback), back
 *  best-effort (no such fallback — see this file's header). Returns null
 *  only when the front view could not be obtained at all, shiny or normal
 *  (offline) — the caller shows a pokeball and a toast.
 *
 * `shiny` (Phase 5 §2, default false) selects the Showdown/Smogon shiny
 * variant. Bundled species have no local shiny sheets, so a shiny pick
 * always comes through here — see GardenScene's `resolveAnimation`. */
export function loadLazyAnimation(id: string, shiny = false): Promise<PokemonAnimation | null> {
  const key = shiny ? `${id}:shiny` : id;
  const existing = animationCache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<PokemonAnimation | null> => {
    const entry = speciesEntry(id);
    if (!entry) return null;
    const front = await loadFrontWithShinyFallback(id, shiny);
    if (!front) return null;
    const back = await loadView(id, 'back', shiny, false).catch(() => null);
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

  animationCache.set(key, promise);
  void promise.then((result) => {
    if (result === null) animationCache.delete(key);
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

/** Decode ONLY a GIF's first frame — no `coalesceGif`, no `buildSheet`. Frame
 *  0 has no prior canvas state to composite against, so its own patch drawn
 *  onto an `lsd.width x lsd.height` canvas at its own (left, top) offset
 *  already IS the complete first image — the same rule `coalesceGif` applies
 *  frame-by-frame, with only one frame to apply it to here. `decompressFrame`
 *  (singular — unlike `decompressFrames`) decodes just that one block, so a
 *  picker preview never pays to LZW-decompress and canvas-composite the other
 *  50-180 frames of a species nobody has picked. */
function decodeGifFirstFrame(gifBytes: ArrayBuffer): HTMLCanvasElement | null {
  const gif = parseGIF(gifBytes);
  const firstFrame = gif.frames.find((f): f is Parameters<typeof decompressFrame>[0] => 'image' in f);
  if (!firstFrame) return null;
  const decoded = decompressFrame(firstFrame, gif.gct, true);

  const canvas = document.createElement('canvas');
  canvas.width = gif.lsd.width;
  canvas.height = gif.lsd.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const patchCanvas = document.createElement('canvas');
  patchCanvas.width = decoded.dims.width;
  patchCanvas.height = decoded.dims.height;
  patchCanvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(decoded.patch), decoded.dims.width, decoded.dims.height), 0, 0);
  ctx.drawImage(patchCanvas, decoded.dims.left, decoded.dims.top);
  return canvas;
}

/** One species' first-frame art, fetched and decoded WITHOUT going through
 *  `loadView`/`viewCache`/the disk cache — see this file's header for why a
 *  picker preview must not pay the full-sheet decode. Static species
 *  (#650-1025) are already a single frame, so reusing `fetchAndDecodeStatic`
 *  costs nothing extra (it never touches `viewCache` or the disk cache
 *  either). */
async function decodeThumbnailFrame(id: string, view: SpriteView, shiny: boolean): Promise<HTMLCanvasElement | null> {
  if (speciesEntry(id)?.static) {
    const decoded = await fetchAndDecodeStatic(id, view, shiny);
    return decoded?.sheet ?? null;
  }
  const gifBytes = await window.api.fetchSpriteGif(id, view, shiny);
  return gifBytes ? decodeGifFirstFrame(gifBytes) : null;
}

/** `decodeThumbnailFrame`, plus the shiny-specific fallback — same rule as
 *  `loadFrontWithShinyFallback`, kept separate because the thumbnail path
 *  must not touch `viewCache`. */
async function decodeThumbnailFrameWithShinyFallback(id: string, shiny: boolean): Promise<HTMLCanvasElement | null> {
  const primary = await decodeThumbnailFrame(id, 'front', shiny);
  if (primary || !shiny) return primary;
  console.error(`[lazySprites] ${id}: shiny front sprite unavailable — falling back to normal (thumbnail)`);
  return decodeThumbnailFrame(id, 'front', false);
}

/** Crop frame 0 out of an already-decoded FrameSet — a real walker's sheet,
 *  already resident in `viewCache` — into a thumbnail data URL, with no new
 *  fetch or decode. */
function cropFrame0(front: FrameSet): string | null {
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
}

/** A single still frame of a lazy species, as a data URL, for the picker's
 *  search results and (`shiny`, Phase 5 §4) a shiny session's face thumbnail.
 *  Deliberately does NOT share `loadView`'s cache: a search result page can
 *  put dozens of species on screen that nobody ends up picking, and decoding
 *  (and disk-caching) each one's FULL animated sheet just to crop frame 0 out
 *  of it is what used to balloon memory from picker browsing alone — see this
 *  file's header. If a full pick has already decoded this species (it's an
 *  actual walker), this reuses that decode instead of fetching a second time.
 *  Falls back shiny→normal on a 404, same as loadLazyAnimation. */
export function loadLazyThumbnail(id: string, shiny = false): Promise<string | null> {
  const key = shiny ? `${id}:shiny` : id;
  const existing = thumbnailCache.get(key);
  if (existing) return existing;

  const promise = thumbnailGate(async (): Promise<string | null> => {
    const alreadyDecoded = viewCache.get(`${id}:front:${shiny ? 'shiny' : 'normal'}`);
    if (alreadyDecoded) {
      const front = await alreadyDecoded;
      if (front) return cropFrame0(front);
    }
    const canvas = await decodeThumbnailFrameWithShinyFallback(id, shiny);
    return canvas ? canvas.toDataURL('image/png') : null;
  });

  thumbnailCache.set(key, promise);
  void promise.then((result) => {
    if (result === null) thumbnailCache.delete(key);
  });
  return promise;
}
