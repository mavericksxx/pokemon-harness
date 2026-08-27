/**
 * The walkers' art: Pokemon Showdown's animated Gen-5 battle sprites.
 *
 * SWAP SEAM (character side): every sheet is one horizontal strip of
 * `frameCount` frames at native size, and everything about it — geometry, the
 * per-frame durations, how the Pokemon gets around — comes from
 * `assets/showdown/manifest.json`. Nothing here hardcodes a species: the sheets
 * are picked up by a glob, so adding one is a PNG plus a manifest entry.
 *
 * These are idle animations, not walk cycles. A moving walker keeps playing the
 * same loop and glides along its path, mirrored to face its direction of travel
 * — which is how Showdown sprites are meant to be used.
 *
 * Licence and fan-use disclaimer: assets/ASSETS.md.
 */
import { Texture } from 'pixi.js';
import { loadPixelTexture } from './imageTexture';
import { sliceFrames } from './spriteSheet';
import manifest from '@assets/showdown/manifest.json';

/** How a species gets around, which decides whether it can cross the pond. */
export type Locomotion = 'walk' | 'fly' | 'levitate';

interface ManifestSheet {
  /** Sheet filename, relative to assets/showdown/ (back sheets: relative to
   *  assets/showdown/back/). */
  image: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Milliseconds to hold each frame — either one value for the whole loop or
   *  one per frame. The rip emits both forms. */
  durations?: number | number[];
}

interface ManifestEntry extends ManifestSheet {
  name: string;
  dex: number;
  hasBack?: boolean;
  back?: ManifestSheet;
  locomotion?: Locomotion;
  /** Evolution data: the line's id, this species' 1-based stage within it, and
   *  the name(s) of the next stage (branching for Eevee, empty at the top). */
  line?: string;
  stage?: number;
  evolvesTo?: string[];
}

// One cast at the boundary: the manifest is data, and TS widens its repeated
// object literals into shapes that are awkward to index.
const RAW = manifest as unknown as Record<string, unknown>;

const isEntry = (value: unknown): value is ManifestEntry =>
  !!value && typeof value === 'object' && typeof (value as ManifestEntry).name === 'string';

// Accepts the manifest either as a flat map keyed by Showdown id or as
// `{ pokemon: [...] }`, and drops anything that is not an entry. Both shapes
// have been delivered, and a stray metadata key used to crash the whole
// renderer on load — the roster is the one thing here that must not be brittle.
const ENTRIES: ManifestEntry[] = (Array.isArray(RAW.pokemon) ? RAW.pokemon : Object.values(RAW))
  .filter(isEntry)
  // Dex order, so the picker grid reads like a Pokedex rather than like a
  // directory listing.
  .sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));

if (ENTRIES.length === 0) console.error('[showdown] manifest produced no Pokemon');

// Sheets are found rather than listed, so the roster is the manifest's alone.
// The path is relative (not via the @assets alias) because Vite resolves glob
// patterns against this file on disk. `_preview.png` is a human contact sheet,
// not art the app uses; excluding it keeps it out of the bundle. The glob is
// deliberately non-recursive, so `back/*.png` needs its own glob below.
const SHEET_MODULES = import.meta.glob(
  ['../../../../../assets/showdown/*.png', '!../../../../../assets/showdown/_*.png'],
  { eager: true, query: '?url', import: 'default' }
) as Record<string, string>;

const BACK_SHEET_MODULES = import.meta.glob('../../../../../assets/showdown/back/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

/** Sheet filename (as the manifest's `image` names it) → bundled URL. */
export const SHEET_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(SHEET_MODULES)) {
  SHEET_URLS[path.slice(path.lastIndexOf('/') + 1)] = url;
}

/** Back-sheet filename (as the manifest's `back.image` names it, e.g.
 *  `back/bulbasaur.png`) → bundled URL. */
export const BACK_SHEET_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(BACK_SHEET_MODULES)) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash).split('/').pop();
  BACK_SHEET_URLS[`${dir}/${path.slice(slash + 1)}`] = url;
}

/** Hold time for frame `i`, whichever form the manifest used. */
function frameTime(sheet: ManifestSheet, i: number): number {
  const d = sheet.durations;
  if (typeof d === 'number') return d;
  return d?.[i] ?? DEFAULT_FRAME_MS;
}

/** Fallback when a manifest entry omits per-frame durations. */
const DEFAULT_FRAME_MS = 110;

/**
 * Stand-in for a species whose sheet is missing or fails to decode. A pokeball
 * reads as "art not here yet"; an untextured sprite reads as a rendering bug,
 * which is exactly the wrong impression when the cause is a missing file.
 */
function pokeballTexture(size = 32): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  if (!c) return Texture.EMPTY;
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size * 0.58;
  c.imageSmoothingEnabled = false;
  c.beginPath();
  c.arc(cx, cy, r, Math.PI, 0);
  c.fillStyle = '#e5484d';
  c.fill();
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI);
  c.fillStyle = '#f2f2f2';
  c.fill();
  c.fillStyle = '#1b1b1b';
  c.fillRect(cx - r, cy - size * 0.06, r * 2, size * 0.12);
  c.beginPath();
  c.arc(cx, cy, size * 0.15, 0, Math.PI * 2);
  c.fillStyle = '#1b1b1b';
  c.fill();
  c.beginPath();
  c.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
  c.fillStyle = '#f2f2f2';
  c.fill();
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.strokeStyle = '#1b1b1b';
  c.lineWidth = Math.max(1, size * 0.06);
  c.stroke();
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

export interface PokemonInfo {
  name: string;
  dex: number;
  /** Capitalised, for the UI. */
  label: string;
  locomotion: Locomotion;
  frameWidth: number;
  frameHeight: number;
  sheetUrl: string;
  /** Evolution line id (shared by every stage) and this species' 1-based stage
   *  within it. Branching (Eevee) and top-of-line (empty) both show here. */
  line: string;
  stage: number;
  evolvesTo: string[];
  hasBack: boolean;
}

/** One direction's idle loop: Pixi FrameObjects (texture + hold time in ms). */
export interface FrameSet {
  frameWidth: number;
  frameHeight: number;
  frames: { texture: Texture; time: number }[];
}

/** One species' art: the front loop always, the back loop when a back sheet
 *  exists (Phase 3 §3 — walking predominantly upward uses it). */
export interface PokemonAnimation {
  info: PokemonInfo;
  front: FrameSet;
  back?: FrameSet;
}

const toInfo = (entry: ManifestEntry): PokemonInfo => ({
  name: entry.name,
  dex: entry.dex,
  label: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
  locomotion: entry.locomotion ?? 'walk',
  frameWidth: entry.frameWidth,
  frameHeight: entry.frameHeight,
  sheetUrl: SHEET_URLS[entry.image] ?? '',
  line: entry.line ?? entry.name,
  stage: entry.stage ?? 1,
  evolvesTo: entry.evolvesTo ?? [],
  hasBack: !!entry.hasBack
});

export const POKEMON_ROSTER: readonly PokemonInfo[] = ENTRIES.map(toInfo);

/** Bundled species keyed by name, for evolution/dex lookups elsewhere. */
export const BUNDLED_BY_NAME: ReadonlyMap<string, ManifestEntry> = new Map(
  ENTRIES.map((e) => [e.name, e])
);

async function loadFrameSet(sheet: ManifestSheet, sheetUrl: string): Promise<FrameSet> {
  const texture = await loadPixelTexture(sheetUrl);
  const geo = { frameWidth: sheet.frameWidth, frameHeight: sheet.frameHeight, frameCount: sheet.frameCount };
  const textures = sliceFrames(texture, geo);
  return {
    frameWidth: sheet.frameWidth,
    frameHeight: sheet.frameHeight,
    frames: textures.map((t, i) => ({ texture: t, time: frameTime(sheet, i) }))
  };
}

/** Stand-in art for a species whose sheet is missing, still loading (lazy
 *  fetch), or failed outright. Exported for `lazySprites.ts`'s placeholder. */
export function pokeballFrameSet(): FrameSet {
  const texture = pokeballTexture();
  return {
    frameWidth: texture.width,
    frameHeight: texture.height,
    frames: [{ texture, time: DEFAULT_FRAME_MS }]
  };
}

/** Sheets are needed the moment a session appears, so they load once, up front. */
export async function loadPokemonAnimations(): Promise<Map<string, PokemonAnimation>> {
  const loaded = await Promise.all(
    ENTRIES.map(async (entry) => {
      const info = toInfo(entry);
      try {
        if (!info.sheetUrl) throw new Error('no sheet file on disk for this manifest entry');
        const front = await loadFrameSet(entry, info.sheetUrl);
        let back: FrameSet | undefined;
        if (entry.back) {
          const backUrl = BACK_SHEET_URLS[entry.back.image];
          if (backUrl) {
            try {
              back = await loadFrameSet(entry.back, backUrl);
            } catch (err) {
              console.error(`[showdown] ${entry.name}: back sheet failed to load —`, err);
            }
          }
        }
        return [entry.name, { info, front, back }] as const;
      } catch (err) {
        // One missing sheet must not take the whole garden down with it, but it
        // must be findable — say which species and why, then stand a pokeball in.
        console.error(`[showdown] ${entry.name}: sheet failed to load —`, err);
        const front = pokeballFrameSet();
        const fallback: PokemonAnimation = {
          info: { ...info, frameWidth: front.frameWidth, frameHeight: front.frameHeight },
          front
        };
        return [entry.name, fallback] as const;
      }
    })
  );
  return new Map(loaded);
}

/** A bundled evolution LINE no live session is using (by base-stage name), or
 *  — if all are taken — a random one. Only among the 42 bundled species, so
 *  the default/random assignment never needs a network fetch. */
export function pickFreeLine(takenLines: readonly string[]): PokemonInfo {
  const bases = POKEMON_ROSTER.filter((p) => p.stage === 1);
  const free = bases.filter((p) => !takenLines.includes(p.line));
  const pool = free.length > 0 ? free : bases;
  return pool[Math.floor(Math.random() * pool.length)];
}
