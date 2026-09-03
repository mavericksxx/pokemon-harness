/**
 * Runtime sprite cache for species not bundled in assets/showdown/ (Phase 3
 * §2). Main owns both actors the renderer's CSP forbids — network fetches and
 * the disk cache under `userData/sprites/` — and hands the renderer raw bytes.
 * Decoding the art and re-encoding the coalesced sheet as a PNG happens in
 * the renderer (`lazySprites.ts`), which has a DOM/canvas; main does not.
 *
 * Phase 6 §1/§3: species #650-1025 have no Showdown gen5ani animation, so
 * they use the Smogon Sprite Project's static Gen-5-style PNGs (`gen5`,
 * `gen5-back`) instead of the animated GIF sets. `fetchSpriteGif` (name kept
 * for the existing IPC contract in `src/main/index.ts` — Phase 6 stays out of
 * that file) picks the right base URL and extension per id by consulting the
 * generated dex's `static` flag; it returns raw bytes either way; the
 * renderer decides how to decode them the same way it already knows a
 * species is static (`dexData.ts`).
 *
 * Phase 5 §2: shiny variants live one path segment over — Showdown/Smogon
 * both name them by appending `-shiny` to the same base directory
 * (`gen5ani` → `gen5ani-shiny`, `gen5-back` → `gen5-back-shiny`, etc.), so a
 * shiny fetch is the same URL with that suffix tacked on. Cache files get a
 * `-shiny` filename suffix too, so a shiny and normal pick of the same
 * species/view never collide on disk.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CachedSprite, LazySpriteMeta, SpriteView } from '../shared/types';
// Plain data import (JSON), not the renderer's `@assets` alias — that alias
// is only configured for the renderer's Vite build (electron.vite.config.ts),
// which Phase 6 does not touch.
import dexIndex from '../../assets/dex/dexIndex.json';

interface DexEntryLite {
  static?: boolean;
}
const DEX = dexIndex as unknown as Record<string, DexEntryLite>;

const SPRITE_BASE = {
  front: {
    animated: 'https://play.pokemonshowdown.com/sprites/gen5ani',
    static: 'https://play.pokemonshowdown.com/sprites/gen5'
  },
  back: {
    animated: 'https://play.pokemonshowdown.com/sprites/gen5ani-back',
    static: 'https://play.pokemonshowdown.com/sprites/gen5-back'
  }
} satisfies Record<SpriteView, Record<'animated' | 'static', string>>;

function cacheDir(): string {
  return join(app.getPath('userData'), 'sprites');
}

function cachePaths(id: string, view: SpriteView, shiny: boolean): { png: string; meta: string } {
  const base = join(cacheDir(), `${id}-${view}${shiny ? '-shiny' : ''}`);
  return { png: `${base}.png`, meta: `${base}.json` };
}

/** A previously-cached sheet, if this species/view/shininess has been fetched
 *  before — so a second pick never hits the network again. */
export async function getCachedSprite(
  id: string,
  view: SpriteView,
  shiny: boolean
): Promise<CachedSprite | null> {
  const { png, meta } = cachePaths(id, view, shiny);
  if (!existsSync(png) || !existsSync(meta)) return null;
  try {
    const [pngBuf, metaBuf] = await Promise.all([readFile(png), readFile(meta)]);
    return {
      png: pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.byteLength),
      meta: JSON.parse(metaBuf.toString('utf8')) as LazySpriteMeta
    };
  } catch {
    // A half-written or corrupt cache entry must not crash the pick — treat it
    // as a miss and let the caller re-fetch.
    return null;
  }
}

export async function saveCachedSprite(
  id: string,
  view: SpriteView,
  shiny: boolean,
  png: ArrayBuffer,
  meta: LazySpriteMeta
): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const { png: pngPath, meta: metaPath } = cachePaths(id, view, shiny);
  await Promise.all([writeFile(pngPath, Buffer.from(png)), writeFile(metaPath, JSON.stringify(meta))]);
}

/** Raw sprite bytes — an animated GIF for #1-649, a static PNG for #650-1025
 *  (Phase 6 §1/§3), shiny or not (Phase 5 §2) — or null on any failure
 *  (offline, 404). The renderer falls back to a pokeball placeholder and a
 *  non-blocking toast either way (and, for a shiny 404 specifically, falls
 *  back further to the normal sprite — see lazySprites.ts). */
export async function fetchSpriteGif(
  id: string,
  view: SpriteView,
  shiny: boolean,
  explicitKind?: 'animated' | 'static'
): Promise<ArrayBuffer | null> {
  const kind = explicitKind ?? (DEX[id]?.static ? 'static' : 'animated');
  const ext = kind === 'static' ? 'png' : 'gif';
  const base = SPRITE_BASE[view][kind];
  try {
    const res = await fetch(`${shiny ? `${base}-shiny` : base}/${id}.${ext}`);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}
