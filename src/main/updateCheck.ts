/**
 * Tier-1 update check (ship-cut item 4) — GitHub's "latest release" endpoint,
 * checked on launch and every 24h (see main/index.ts's `setInterval`), plus
 * on demand from the Settings panel's "check now". Main-only: the renderer's
 * CSP has no connect-src beyond self/blob (see index.html), same reasoning
 * as sprites/audio/music being main-side fetches (spriteCache.ts,
 * musicCache.ts).
 *
 * No auto-download, no signature verification, no notarization — this just
 * tells the user a newer version exists and opens the release page in their
 * browser if they click through. Silent on any network failure (offline,
 * GitHub down, rate-limited): a failed check is indistinguishable from "no
 * update" to the caller, never a thrown error or a toast of its own.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateCheckResult } from '../shared/updateTypes';

const REPO = 'mavericksxx/pokemon-harness';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 10_000;
/** GitHub requires a User-Agent on every request; identifying the app
 *  (rather than spoofing a browser, musicCache.ts's khinsider workaround)
 *  is the documented-friendly convention for the GitHub API specifically. */
const UA = `pokeharness/${app.getVersion()}`;

interface UpdateCache {
  /** Last response's ETag, sent back as If-None-Match so an unchanged
   *  latest release costs GitHub a cheap 304 instead of a full body. */
  etag: string | null;
  /** Last release actually seen (tag + page URL), kept so a 304 (or an
   *  offline "check now") can still report last-known status instead of
   *  nothing at all. */
  lastKnownVersion: string | null;
  lastKnownUrl: string | null;
}

const EMPTY_CACHE: UpdateCache = { etag: null, lastKnownVersion: null, lastKnownUrl: null };

function cachePath(): string {
  return join(app.getPath('userData'), 'update-check.json');
}

async function loadCache(): Promise<UpdateCache> {
  const p = cachePath();
  if (!existsSync(p)) return { ...EMPTY_CACHE };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<UpdateCache>;
    return { ...EMPTY_CACHE, ...raw };
  } catch {
    return { ...EMPTY_CACHE };
  }
}

async function saveCache(cache: UpdateCache): Promise<void> {
  const p = cachePath();
  await mkdir(join(app.getPath('userData')), { recursive: true });
  await writeFile(p, JSON.stringify(cache));
}

/** `"v1.2.3"` / `"1.2.3"` -> `[1, 2, 3]`, ignoring any `-prerelease`/`+build`
 *  suffix. Malformed input reads as `[0, 0, 0]` (never newer than anything),
 *  so a weird tag name fails safe rather than falsely announcing an update. */
function parseSemver(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewer(latest: string, current: string): boolean {
  const [la, lb, lc] = parseSemver(latest);
  const [ca, cb, cc] = parseSemver(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
}

/** Runs one check. Never throws — every failure path (network, timeout,
 *  malformed response) resolves `null`, the caller's cue to stay silent. */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  const currentVersion = app.getVersion();
  const cache = await loadCache();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        ...(cache.etag ? { 'If-None-Match': cache.etag } : {})
      }
    });

    if (res.status === 304) {
      // Unchanged since last check — report the last-known release (if any)
      // against the CURRENT app version, since the app itself may have
      // changed (e.g. this same check ran again after an in-place upgrade)
      // even though GitHub's answer didn't.
      if (!cache.lastKnownVersion || !cache.lastKnownUrl) return null;
      return {
        available: isNewer(cache.lastKnownVersion, currentVersion),
        currentVersion,
        latestVersion: cache.lastKnownVersion,
        releaseUrl: cache.lastKnownUrl
      };
    }

    if (!res.ok) return null;

    const etag = res.headers.get('etag');
    const body = (await res.json()) as GithubRelease;
    const latestVersion = body.tag_name;
    const releaseUrl = body.html_url;
    if (!latestVersion || !releaseUrl) return null;

    await saveCache({ etag, lastKnownVersion: latestVersion, lastKnownUrl: releaseUrl });

    return {
      available: isNewer(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      releaseUrl
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
