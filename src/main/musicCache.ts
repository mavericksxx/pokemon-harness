/**
 * HGSS OST tracks, fetched at runtime from khinsider and cached to userData
 * (Phase 7) — mirrors `spriteCache.ts`'s pattern: main owns the network and
 * disk actors the renderer's CSP forbids; the renderer just gets bytes.
 *
 * khinsider serves no direct download link — getting an mp3 is a two-hop
 * scrape, verified live against the real site (see commit message / ASSETS.md
 * for the trace): the album page lists one `<a href>` per track pointing at a
 * per-track HTML page (`.../album/<slug>/<NN>.%20<Title>.mp3` — note that's an
 * HTML page despite the `.mp3`-looking href, and its query string is already
 * double URL-encoded by khinsider itself, e.g. `%2520` for a literal `%20` —
 * taken verbatim from the scraped href, never re-encoded here); that page
 * embeds the actual audio file's URL at `nu.vgmtreasurechest.com`. Matched by
 * TRACK NUMBER prefix (`"09."`), not by title text — track titles carry
 * accents/em-dashes/punctuation (e.g. "Battle! (Wild Pokémon—Johto Version)")
 * that make robust title->slug matching far more brittle than the numeric
 * prefix every track filename already starts with.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MusicTrackId } from '../shared/audioTypes';

const ALBUM_SLUG = 'pokemon-heartgold-and-soulsilver';
const ALBUM_URL = `https://downloads.khinsider.com/game-soundtracks/album/${ALBUM_SLUG}`;
// Sent on every request out of caution — untested whether khinsider actually
// rejects a request with no browser-like User-Agent, since live verification
// always sent one from the first request onward.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;

/** This album's track number for each id we want — see the file header for
 *  why matching is by number, not title. */
const TRACK_NUMBERS: Record<MusicTrackId, number> = {
  route29: 9,
  newBarkTown: 4,
  cherrygroveCity: 13,
  violetCity: 22,
  azaleaTown: 33,
  battleWild: 10,
  battleTrainer: 18,
  evolutionCharge: 39,
  evolutionFanfare: 40
};

function cacheDir(): string {
  return join(app.getPath('userData'), 'audio', 'music');
}

function cachePath(id: MusicTrackId): string {
  return join(cacheDir(), `${id}.mp3`);
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': UA, ...opts.headers } });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// The album page is ~370KB and every track's page URL comes from it — fetched
// once per main-process lifetime and reused, not once per track.
let albumHtmlPromise: Promise<string | null> | null = null;
function albumHtml(): Promise<string | null> {
  if (!albumHtmlPromise) {
    albumHtmlPromise = fetchWithTimeout(ALBUM_URL).then((res) => res?.text() ?? null);
  }
  return albumHtmlPromise;
}

/** The scraped, already-double-encoded href for track `num`'s page, e.g.
 *  `/game-soundtracks/album/.../09.%2520Route%252029.mp3` (an HTML page, not
 *  actually an mp3 — see file header). */
async function findTrackPageHref(num: number): Promise<string | null> {
  const html = await albumHtml();
  if (!html) return null;
  const prefix = String(num).padStart(2, '0');
  const re = new RegExp(`href="(/game-soundtracks/album/${ALBUM_SLUG}/${prefix}\\.[^"]+\\.mp3)"`);
  const m = html.match(re);
  return m ? m[1] : null;
}

/** The real, direct mp3 URL embedded in a track's page. */
async function findDirectMp3Url(trackPageHref: string): Promise<string | null> {
  const res = await fetchWithTimeout(`https://downloads.khinsider.com${trackPageHref}`);
  if (!res) return null;
  const html = await res.text();
  const m = html.match(/https:\/\/nu\.vgmtreasurechest\.com\/[^"]+\.mp3/);
  return m ? m[0] : null;
}

/** Bytes for a previously-cached track, or null if not yet fetched. */
export async function getCachedTrack(id: MusicTrackId): Promise<ArrayBuffer | null> {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  try {
    const buf = await readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
}

/** Cached bytes if present; otherwise the full khinsider two-hop fetch,
 *  cached to disk before returning. Null on any failure (offline, 404, a
 *  layout change upstream) — the caller (audioEngine) treats that as "skip
 *  this track" rather than a crash. */
export async function ensureMusicTrack(id: MusicTrackId): Promise<ArrayBuffer | null> {
  const cached = await getCachedTrack(id);
  if (cached) return cached;

  const num = TRACK_NUMBERS[id];
  const pageHref = await findTrackPageHref(num);
  if (!pageHref) return null;
  const mp3Url = await findDirectMp3Url(pageHref);
  if (!mp3Url) return null;
  const res = await fetchWithTimeout(mp3Url);
  if (!res) return null;

  const bytes = await res.arrayBuffer();
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(cachePath(id), Buffer.from(bytes));
  return bytes;
}
