/**
 * costHistoryScan — standalone helper process for the tray popover's cost-
 * history section (GitHub issue #17's locked-in scope addition).
 *
 * Spawned via ELECTRON_RUN_AS_NODE (same launcher pattern as ptyKeeper.ts —
 * see pty.ts's `detachToKeeper` and this feature's own costHistory.ts),
 * NOT part of the normal main-process bundle's runtime flow: this is its
 * own electron-vite entry (electron.vite.config.ts), built to a sibling
 * `out/main/costHistoryScan.js`, and only ever imported by costHistory.ts as
 * a path string to spawn, never as a module.
 *
 * Why a separate process rather than just doing this inline in main: a real
 * scan of `~/.claude/projects/**\/*.jsonl` over a 30-day window is genuinely
 * heavy — benchmarked at ~4.4s of CPU-bound JSON.parse on a modest personal
 * `~/.claude/projects` (1.4GB across 571 files). Running that on the main
 * process's own JS thread would freeze every other main-process callback —
 * PTY I/O, IPC, the usage poller — for the whole scan. costHistory.ts caches
 * this process's output with a TTL and never re-spawns on every popover
 * open, so this only actually runs every few minutes at most.
 *
 * Reads argv: [2] = root directory to scan (`~/.claude/projects`, or a test
 * fixture directory), [3] = lookback window in days. Writes one JSON-encoded
 * `CostHistorySnapshot` (costHistoryTypes.ts) to stdout and exits 0. A
 * per-file or per-line failure is swallowed (best-effort, same fault
 * tolerance as costWatcher.ts's own transcript parsing) — only a fatal error
 * before any output (e.g. the root directory doesn't exist) exits non-zero,
 * which costHistory.ts treats as "no data this scan", not a crash.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { CostHistoryDay, CostHistorySnapshot } from '../shared/costHistoryTypes';
import { costForUsage, isPlaceholderModel } from './pricing';

/** Recursively collects every `*.jsonl` path under `dir` (transcripts live
 *  one level deep under a project folder, but a session's own `subagents/`
 *  folder nests a level further — see costWatcher.ts's header — so this
 *  walks arbitrarily deep rather than assuming a fixed depth). Best-effort:
 *  a directory that vanishes mid-walk or can't be read is just skipped. */
function collectJsonlFiles(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path);
    }
  }
}

/** Local calendar day (`YYYY-MM-DD`) for a Date — matches this codebase's
 *  existing local-time convention for day bucketing (usageService.ts's Codex
 *  rollout-log day-directory computation uses the same getFullYear/getMonth/
 *  getDate calls). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { model?: string; usage?: Record<string, number> };
}

function scan(root: string, lookbackDays: number): CostHistorySnapshot {
  const now = new Date();
  // Anchored at local midnight, not "exactly lookbackDays*24h before now" —
  // the buckets below are CALENDAR days, so the cutoff has to be the oldest
  // bucket's own midnight. A rolling exact-duration cutoff would sit partway
  // through that oldest bucket's day (whatever `now`'s time-of-day is),
  // which silently drops any entry between that cutoff and local midnight
  // from every day-bucket (it fails the cutoff-filter's `key` lookup below)
  // while still counting it in `last30dTokens`/`topModel` — an inconsistency
  // between "30-day cost" and "30-day tokens" that was caught before this
  // ever shipped.
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Zero-filled day buckets, oldest first — built up front so the popover's
  // sparkline never has to reason about missing days.
  const dayOrder: string[] = [];
  const costByDay = new Map<string, number>();
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const d = new Date(todayMidnight);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    dayOrder.push(key);
    costByDay.set(key, 0);
  }
  const todayKey = dayOrder[dayOrder.length - 1];
  const oldestMidnight = new Date(todayMidnight);
  oldestMidnight.setDate(oldestMidnight.getDate() - (lookbackDays - 1));
  const cutoffMs = oldestMidnight.getTime();

  const files: string[] = [];
  collectJsonlFiles(root, files);

  let last30dTokens = 0;
  let latestTurnTokens: number | null = null;
  let latestTurnAt = -Infinity;
  const tokensByModel = new Map<string, number>();

  for (const path of files) {
    // A file's mtime is (at most microseconds after) its last-written
    // entry's own timestamp — entries are appended chronologically and
    // never rewritten — so a file whose mtime already predates the lookback
    // cutoff cannot contain ANY entry inside the window. Skipping those
    // files without opening them is what keeps this scan proportional to
    // recent activity instead of the whole (multi-GB, multi-year) archive.
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoffMs) continue;

    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    // Per-file "last real model" carry — mirrors costWatcher.ts's
    // TrackedSession.lastModel: a placeholder model id (e.g. `<synthetic>`)
    // on one line must resolve to the nearest earlier real model in the
    // SAME transcript, not a global fallback.
    let lastModel: string | null = null;

    for (const line of content.split('\n')) {
      if (!line || line.indexOf('"type":"assistant"') === -1) continue; // cheap pre-filter before JSON.parse
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // torn line (read mid-write) — skip
      }
      if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      const parsedModel: string | null = entry.message?.model ?? null;
      const model: string | null = isPlaceholderModel(parsedModel) ? lastModel : parsedModel;
      lastModel = model;

      const inputTok = usage.input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const outputTok = usage.output_tokens ?? 0;
      const turnTokens = inputTok + cacheCreate + cacheRead + outputTok;

      const cost = costForUsage({ inputTok, cacheCreate, cacheRead, outputTok }, model);
      const key = dayKey(new Date(ts));
      const existing = costByDay.get(key);
      if (existing !== undefined) costByDay.set(key, existing + cost);

      last30dTokens += turnTokens;
      if (model) tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + turnTokens);

      if (ts > latestTurnAt) {
        latestTurnAt = ts;
        latestTurnTokens = turnTokens;
      }
    }
  }

  const days: CostHistoryDay[] = dayOrder.map((date) => ({ date, costUsd: costByDay.get(date) ?? 0 }));
  const last30dCostUsd = days.reduce((sum, d) => sum + d.costUsd, 0);

  let topModel: CostHistorySnapshot['topModel'] = null;
  for (const [model, tokens] of tokensByModel) {
    if (!topModel || tokens > topModel.tokens) topModel = { model, tokens };
  }

  return {
    generatedAt: Date.now(),
    days,
    todayCostUsd: costByDay.get(todayKey) ?? 0,
    last30dCostUsd,
    latestTurnTokens,
    last30dTokens,
    topModel
  };
}

const root = process.argv[2];
const lookbackDays = Number(process.argv[3]);
if (!root || !Number.isFinite(lookbackDays) || lookbackDays <= 0) {
  process.stderr.write('costHistoryScan: usage: costHistoryScan.js <root> <lookbackDays>\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(scan(root, lookbackDays)));
