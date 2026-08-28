/**
 * Pokemon cry clips, fetched from Pokemon Showdown and cached to userData
 * (Phase 7) — same fetch-and-cache pattern as `spriteCache.ts` and
 * `musicCache.ts`. Keyed by the same Showdown-style dex id the sprite cache
 * and `dexData.ts` already use, so no separate id mapping is needed.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CRY_BASE = 'https://play.pokemonshowdown.com/audio/cries';
const FETCH_TIMEOUT_MS = 8_000;

function cacheDir(): string {
  return join(app.getPath('userData'), 'audio', 'cries');
}

function cachePath(id: string): string {
  return join(cacheDir(), `${id}.mp3`);
}

export async function getCachedCry(id: string): Promise<ArrayBuffer | null> {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  try {
    const buf = await readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
}

/** Cached bytes if present; otherwise fetches `<id>.mp3` from Showdown,
 *  caches it, and returns it. Null on any failure (offline, no cry for this
 *  id) — callers just skip the cry rather than erroring. */
export async function ensureCry(id: string): Promise<ArrayBuffer | null> {
  const cached = await getCachedCry(id);
  if (cached) return cached;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CRY_BASE}/${id}.mp3`, { signal: controller.signal });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePath(id), Buffer.from(bytes));
    return bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
