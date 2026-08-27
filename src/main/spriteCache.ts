/**
 * Runtime sprite cache for species not bundled in assets/showdown/ (Phase 3
 * §2). Main owns both actors the renderer's CSP forbids — network fetches and
 * the disk cache under `userData/sprites/` — and hands the renderer raw bytes.
 * Decoding the GIF and re-encoding the coalesced sheet as a PNG happens in the
 * renderer (`lazySprites.ts`), which has a DOM/canvas; main does not.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CachedSprite, LazySpriteMeta, SpriteView } from '../shared/types';

const SPRITE_BASE: Record<SpriteView, string> = {
  front: 'https://play.pokemonshowdown.com/sprites/gen5ani',
  back: 'https://play.pokemonshowdown.com/sprites/gen5ani-back'
};

function cacheDir(): string {
  return join(app.getPath('userData'), 'sprites');
}

function cachePaths(id: string, view: SpriteView): { png: string; meta: string } {
  const base = join(cacheDir(), `${id}-${view}`);
  return { png: `${base}.png`, meta: `${base}.json` };
}

/** A previously-cached sheet, if this species/view has been fetched before —
 *  so a second pick never hits the network again. */
export async function getCachedSprite(id: string, view: SpriteView): Promise<CachedSprite | null> {
  const { png, meta } = cachePaths(id, view);
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
  png: ArrayBuffer,
  meta: LazySpriteMeta
): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const { png: pngPath, meta: metaPath } = cachePaths(id, view);
  await Promise.all([writeFile(pngPath, Buffer.from(png)), writeFile(metaPath, JSON.stringify(meta))]);
}

/** Raw GIF bytes from Showdown, or null on any failure (offline, 404) — the
 *  renderer falls back to a pokeball placeholder and a non-blocking toast. */
export async function fetchSpriteGif(id: string, view: SpriteView): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`${SPRITE_BASE[view]}/${id}.gif`);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}
