/**
 * CostHistoryService — tray popover's cost-history section (GitHub issue
 * #17's locked-in scope addition; see that issue's design-decision
 * comment). Owns the cache/TTL/lifecycle around costHistoryScan.ts, the
 * actual scan (spawned as its own short-lived child process — NOT a
 * `detached: true`/outlives-the-app-quit process like ptyKeeper.ts; see
 * that file's own header for the distinction, and this file's own
 * `runScan` for why it isn't done inline on this process's thread).
 *
 * Cheap by construction: a scan is only ever spawned once at boot (`start()`
 * — to warm the cache before the tray popover can possibly be opened) and
 * lazily thereafter, at most every `TTL_MS`, the next time `getSnapshot()`
 * finds the cache stale — deliberately NOT a recurring background timer (see
 * `start()`'s own comment: a menu-bar feature that goes unopened for a whole
 * session shouldn't still pay ~4s of CPU every few minutes regardless).
 * `getSnapshot()` always returns the current cache immediately when it's
 * within TTL, and joins (never duplicates) an already-in-flight scan
 * otherwise.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './diagnostics';
import type { CostHistorySnapshot } from '../shared/costHistoryTypes';

const LOOKBACK_DAYS = 30;
/** Recompute at most this often — task spec: "compute once, cache with a
 *  TTL (e.g. recompute at most every few minutes)". */
const TTL_MS = 5 * 60_000;
/** Real, bounded CPU work (costHistoryScan.ts's own header has a benchmark)
 *  but must never hang forever on a wedged child process. */
const SCAN_TIMEOUT_MS = 60_000;

/** `costHistoryScan.ts`'s own build output — a sibling of this bundle's own
 *  file, same `__dirname`-relative pattern pty.ts's `keeperScriptPath` and
 *  this file's own electron-vite entry use. */
function scanScriptPath(): string {
  return join(__dirname, 'costHistoryScan.js');
}

function emptySnapshot(): CostHistorySnapshot {
  return {
    generatedAt: 0,
    days: [],
    todayCostUsd: 0,
    last30dCostUsd: 0,
    latestTurnTokens: null,
    last30dTokens: 0,
    topModel: null
  };
}

/** Spawns costHistoryScan.js (ELECTRON_RUN_AS_NODE — the same launcher
 *  mechanism pty.ts's `detachToKeeper` uses, but plain `spawn()`, not
 *  `detached: true`: this child lives and dies with the main process, it
 *  isn't meant to survive it), collects its one JSON stdout payload, and
 *  resolves it. Rejects — never crashes this process — on a non-zero exit,
 *  unparseable output, or the timeout guard. */
function runScan(root: string, lookbackDays: number): Promise<CostHistorySnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scanScriptPath(), root, String(lookbackDays)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Buffers collected and concatenated once at the end, not decoded
    // per-chunk — a per-chunk `chunk.toString('utf8')` can split a
    // multibyte UTF-8 character (a session's cwd/model text, this scan's
    // own JSON string values — plenty of non-ASCII in a real
    // `~/.claude/projects` tree) across two `data` events, mangling it.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('cost history scan timed out'));
    }, SCAN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`cost history scan exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as CostHistorySnapshot);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export class CostHistoryService {
  private cached: CostHistorySnapshot | null = null;
  /** Epoch ms of the last scan ATTEMPT — success or failure — not just the
   *  last successful one. Gates `getSnapshot()`'s TTL check on its own, so a
   *  persistently failing scan (huge install, slow disk, the child process
   *  itself broken) still only retries once per `TTL_MS` instead of
   *  respawning — and blocking on the full `SCAN_TIMEOUT_MS` — on every
   *  single popover open. */
  private lastAttemptAt = 0;
  private inFlight: Promise<CostHistorySnapshot> | null = null;

  /** Kicks off ONE background scan at boot — so the cache is warm by the
   *  time the tray popover is first opened rather than making that open
   *  wait out a cold scan. Deliberately NOT a recurring timer: this scan is
   *  real, sustained CPU work (~4s benchmarked — see costHistoryScan.ts's
   *  header), and the tray popover may go unopened for an entire session —
   *  paying that cost every `TTL_MS` regardless would be pure waste for a
   *  menu-bar feature nobody's looking at. `getSnapshot()`'s own TTL check
   *  is what actually re-scans, and only when the popover is opened again
   *  after the cache has gone stale. */
  start(): void {
    void this.refresh();
  }

  /** No-op today (no timer to clear) — kept so index.ts's lifecycle wiring
   *  stays symmetric with every other watcher's start()/stop() pair, and so
   *  adding a future timer back here wouldn't also require a call-site
   *  change. */
  stop(): void {
    /* nothing to tear down */
  }

  /** Current snapshot: the cache as-is when the last ATTEMPT (success or
   *  failure — see `lastAttemptAt`) is still within TTL, otherwise a fresh
   *  scan (joining one already in flight rather than starting a second).
   *  Falls back to the last good cache (or an empty snapshot if there's
   *  never been one) whether that's because of a scan failure or just an
   *  in-TTL read — the popover shows stale or zeroed numbers, never an
   *  error state, for this section. */
  async getSnapshot(): Promise<CostHistorySnapshot> {
    if (Date.now() - this.lastAttemptAt < TTL_MS) return this.cached ?? emptySnapshot();
    return this.refresh();
  }

  private refresh(): Promise<CostHistorySnapshot> {
    if (this.inFlight) return this.inFlight;
    const root = join(homedir(), '.claude', 'projects');
    this.inFlight = runScan(root, LOOKBACK_DAYS)
      .then((snapshot) => {
        this.cached = snapshot;
        this.lastAttemptAt = Date.now();
        return snapshot;
      })
      .catch((e) => {
        log('costHistory', 'warn', 'cost history scan failed', {
          message: e instanceof Error ? e.message : String(e)
        });
        // Record the attempt even though it failed — see `lastAttemptAt`'s
        // own comment for why this still has to gate the NEXT attempt by
        // TTL rather than leaving the door open to retry every call.
        this.lastAttemptAt = Date.now();
        return this.cached ?? emptySnapshot();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
