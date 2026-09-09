/**
 * costHistoryScan — standalone helper process for the tray popover's cost-
 * history section (GitHub issue #17's locked-in scope addition).
 *
 * Spawned via ELECTRON_RUN_AS_NODE — the SAME launcher mechanism ptyKeeper.ts
 * uses (see pty.ts's `detachToKeeper`), but NOT detached the way ptyKeeper
 * is: this is a plain `spawn()` (costHistory.ts's `runScan`), tied to the
 * main process's own lifecycle like any other child process, not a
 * `detached: true` process meant to outlive it. It only ever needs to run
 * for a few seconds while main is already up. NOT part of the normal
 * main-process bundle's runtime flow either way: this is its own
 * electron-vite entry (electron.vite.config.ts), built to a sibling
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
 *
 * Unlike costWatcher.ts, this DOES count `isSidechain: true` (subagent)
 * turns — a deliberate product decision, not an oversight: this project's
 * own workflow runs almost all real work through subagents, so excluding
 * them (costWatcher's own choice, made for a context-occupancy reason that
 * doesn't apply to a total-spend figure) would badly understate "cost".
 * Doing that correctly needs real dedup first — see `scan()`'s own comment
 * for the two duplicate-JSONL-line shapes a real transcript tree actually
 * has, verified directly against this machine's own history before this
 * shipped, not assumed.
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
  timestamp?: string;
  requestId?: string;
  message?: { id?: string; model?: string; usage?: Record<string, number> };
}

/** Raw per-turn usage, already resolved (placeholder model substituted) —
 *  one per UNIQUE message, after dedup. See `scan()`'s own comment on why
 *  dedup is necessary at all before this shape is ever built. */
interface DedupedTurn {
  ts: number;
  inputTok: number;
  cacheCreate: number;
  cacheRead: number;
  outputTok: number;
  model: string | null;
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

  // ─── Pass 1: collect every qualifying assistant turn, deduped by message
  // identity, across EVERY file — not per-file. Two real duplication shapes
  // exist in a real `~/.claude/projects` tree (verified directly against
  // this machine's own transcripts before this shipped, per the product
  // decision to include subagent spend):
  //
  //  1. WITHIN one file, Claude Code writes one JSONL line per completed
  //     CONTENT BLOCK of a turn (thinking/tool_use/text/...), not one line
  //     per turn — a multi-block turn repeats the same `message.id` across
  //     several lines, each carrying that message's usage AS OF that block
  //     (`output_tokens` verified strictly non-decreasing across 2120 real
  //     duplicate-id groups sampled off this machine; `input`/cache tokens
  //     can also jump mid-message for a message that made a server-side
  //     tool call and kept generating after the result came back — that
  //     jump is real re-processed context, not an artifact). Summing every
  //     line for such a turn overcounts it several times over — sampled at
  //     ~65% of top-level turns on this machine having 2+ lines. This was
  //     already a real, shipped bug before subagent-inclusion was even a
  //     factor: only IGNORING it made the original per-line-sum look
  //     plausible.
  //  2. ACROSS files, the exact same message (same `message.id` AND
  //     `requestId`) can appear BOTH in a session's main transcript
  //     (`isSidechain: false` — the orchestrator's own turn that dispatched
  //     a subagent) and again inside that subagent's own
  //     `subagents/*.jsonl` file (`isSidechain: true` there) — confirmed on
  //     3 real occurrences directly. Deduping only within one file's own
  //     loop would still double-count these.
  //
  // The fix for both: key every turn on `message.id` (falling back to
  // `requestId` if that's ever missing — matches the two identifiers a real
  // transcript actually carries, checked directly rather than assumed), and
  // keep only the occurrence with the LATEST timestamp for that key — the
  // final, most-complete usage snapshot for that message, wherever in the
  // scan it's encountered.
  const dedup = new Map<string, DedupedTurn>();

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
    // SAME transcript, not a global fallback. Deliberately still per-file
    // (not part of the cross-file dedup above) — it's resolving what the
    // real model WAS for a given raw line, before that line's turn is ever
    // looked up in the global dedup map.
    let lastModel: string | null = null;

    // Deliberately NOT excluding `isSidechain: true` here (product decision:
    // subagent turns are real spend, and for this project's own
    // orchestrator-only workflow they're MOST of the spend — excluding them
    // would make "cost" badly understate reality, unlike costWatcher.ts's
    // own exclusion of the same field, which exists for a context-occupancy
    // reason that doesn't apply to a total-spend figure).
    for (const line of content.split('\n')) {
      if (!line || line.indexOf('"type":"assistant"') === -1) continue; // cheap pre-filter before JSON.parse
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // torn line (read mid-write) — skip
      }
      if (entry.type !== 'assistant') continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      const key = entry.message?.id || (entry.requestId ? `req:${entry.requestId}` : null);
      if (!key) continue; // no stable identity to dedup on — skip rather than risk overcounting

      const parsedModel: string | null = entry.message?.model ?? null;
      const model: string | null = isPlaceholderModel(parsedModel) ? lastModel : parsedModel;
      lastModel = model;

      const existing = dedup.get(key);
      if (existing && existing.ts >= ts) continue; // an already-seen, later-or-equal snapshot for this same message wins

      dedup.set(key, {
        ts,
        inputTok: usage.input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        outputTok: usage.output_tokens ?? 0,
        model
      });
    }
  }

  // ─── Pass 2: aggregate the deduped set — exactly one entry per real
  // message now, so this is a plain sum with no further identity reasoning.
  let last30dTokens = 0;
  let latestTurnTokens: number | null = null;
  let latestTurnAt = -Infinity;
  const tokensByModel = new Map<string, number>();

  for (const turn of dedup.values()) {
    const turnTokens = turn.inputTok + turn.cacheCreate + turn.cacheRead + turn.outputTok;
    const cost = costForUsage(turn, turn.model);
    const key = dayKey(new Date(turn.ts));
    const existing = costByDay.get(key);
    if (existing !== undefined) costByDay.set(key, existing + cost);

    last30dTokens += turnTokens;
    if (turn.model) tokensByModel.set(turn.model, (tokensByModel.get(turn.model) ?? 0) + turnTokens);

    if (turn.ts > latestTurnAt) {
      latestTurnAt = turn.ts;
      latestTurnTokens = turnTokens;
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
