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
import { Rectangle, Texture } from 'pixi.js';
import { loadPixelTexture } from './imageTexture';
import manifest from '@assets/showdown/manifest.json';

/** How a species gets around, which decides whether it can cross the pond. */
export type Locomotion = 'walk' | 'fly' | 'levitate';

interface ManifestEntry {
  name: string;
  dex: number;
  /** Sheet filename, relative to assets/showdown/. */
  image: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Milliseconds to hold each frame — either one value for the whole loop or
   *  one per frame. The rip emits both forms. */
  durations?: number | number[];
  hasBack?: boolean;
  locomotion?: Locomotion;
  /** Evolution data, unused here; Phase 3's picker reads it. */
  line?: string;
  stage?: number;
  evolvesTo?: string[];
}

// One cast at the boundary: the manifest is a map keyed by Showdown id, and TS
// widens its repeated object literals into shapes that are awkward to index.
const ENTRIES = Object.values(manifest as unknown as Record<string, ManifestEntry>)
  // Dex order, so the picker grid reads like a Pokedex rather than like a
  // directory listing.
  .sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));

// Sheets are found rather than listed, so the roster is the manifest's alone.
// The path is relative (not via the @assets alias) because Vite resolves glob
// patterns against this file on disk.
// `_preview.png` is a human contact sheet, not art the app uses; excluding it
// keeps it out of the bundle. `back/` is not matched — nothing renders back
// views yet, and a walker turns by mirroring.
const SHEET_MODULES = import.meta.glob(
  ['../../../../../assets/showdown/*.png', '!../../../../../assets/showdown/_*.png'],
  { eager: true, query: '?url', import: 'default' }
) as Record<string, string>;

/** Sheet filename (as the manifest's `image` names it) → bundled URL. */
export const SHEET_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(SHEET_MODULES)) {
  SHEET_URLS[path.slice(path.lastIndexOf('/') + 1)] = url;
}

/** Hold time for frame `i`, whichever form the manifest used. */
function frameTime(entry: ManifestEntry, i: number): number {
  const d = entry.durations;
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
}

/** One species' idle loop: Pixi FrameObjects (texture + hold time in ms). */
export interface PokemonAnimation {
  info: PokemonInfo;
  frames: { texture: Texture; time: number }[];
}

const toInfo = (entry: ManifestEntry): PokemonInfo => ({
  name: entry.name,
  dex: entry.dex,
  label: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
  locomotion: entry.locomotion ?? 'walk',
  frameWidth: entry.frameWidth,
  frameHeight: entry.frameHeight,
  sheetUrl: SHEET_URLS[entry.image] ?? ''
});

export const POKEMON_ROSTER: readonly PokemonInfo[] = ENTRIES.map(toInfo);

/** Sheets are needed the moment a session appears, so they load once, up front. */
export async function loadPokemonAnimations(): Promise<Map<string, PokemonAnimation>> {
  const loaded = await Promise.all(
    ENTRIES.map(async (entry) => {
      const info = toInfo(entry);
      try {
        if (!info.sheetUrl) throw new Error('no sheet file on disk for this manifest entry');
        const sheet = await loadPixelTexture(info.sheetUrl);
        const frames = Array.from({ length: entry.frameCount }, (_, i) => ({
          texture: new Texture({
            source: sheet.source,
            frame: new Rectangle(i * entry.frameWidth, 0, entry.frameWidth, entry.frameHeight)
          }),
          time: frameTime(entry, i)
        }));
        return [entry.name, { info, frames }] as const;
      } catch (err) {
        // One missing sheet must not take the whole garden down with it, but it
        // must be findable — say which species and why, then stand a pokeball in.
        console.error(`[showdown] ${entry.name}: sheet failed to load —`, err);
        const texture = pokeballTexture();
        const fallback: PokemonAnimation = {
          info: { ...info, frameWidth: texture.width, frameHeight: texture.height },
          frames: [{ texture, time: DEFAULT_FRAME_MS }]
        };
        return [entry.name, fallback] as const;
      }
    })
  );
  return new Map(loaded);
}

/** A species no live session is using, or — if all are taken — a random one. */
export function pickFreePokemon(taken: readonly string[]): string {
  const free = POKEMON_ROSTER.filter((p) => !taken.includes(p.name));
  const pool = free.length > 0 ? free : POKEMON_ROSTER;
  return pool[Math.floor(Math.random() * pool.length)].name;
}
