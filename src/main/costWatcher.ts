/**
 * CostWatcher — Phase 8.5 Wave B item 1: per-session token/cost telemetry for
 * claude-provider sessions, read from the CLI's own transcript files
 * (`~/.claude/projects/<munged-cwd>/<session-id>.jsonl`).
 *
 * Registration: a session's transcript path comes straight off the Claude
 * Code hook payload's own `transcript_path` field (confirmed present in the
 * installed CLI — see hookBridge.ts's `onRawPayload` wiring in
 * main/index.ts) — no need to reconstruct the munged-cwd directory name
 * ourselves. `registerSession` is idempotent, so it's safe to call on every
 * hook payload rather than gating on SessionStart specifically.
 *
 * Reading: polled (not `fs.watch` — an append-only file under a renderer
 * that's writing it is exactly the rename/coalescing case `fs.watch` is
 * flaky about on macOS), every POLL_MS, tailing from a saved byte offset so
 * a big transcript is never re-read whole. A `\n`-incomplete tail is carried
 * to the next poll rather than parsed.
 *
 * Parsing: each line is one JSONL entry from the CLI's own transcript
 * format. Only `type === 'assistant'` entries carry `usage`; entries with
 * `isSidechain: true` belong to a SUBAGENT's own transcript interleaving
 * (Claude Code also writes those under `subagents/*.jsonl`, but the main
 * transcript can itself carry sidechain-marked lines) and must be excluded,
 * or "most recent usage entry" for context occupancy collapses to whatever
 * tiny subagent turn happened to log last.
 */
import type { WebContents } from 'electron';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { SessionCostUpdate } from '../shared/costTypes';

const POLL_MS = 5_000;

/** $/1M-token input/output rates. Keyed by PREFIX match (checked longest-
 *  first) since a real transcript's `message.model` can carry a dated
 *  snapshot suffix the table below doesn't enumerate — see
 *  `priceForModel`'s fallback. Source: the `claude-api` skill's cached
 *  pricing table (2026-06-24) — Anthropic first-party API rates. Task
 *  instruction: "keep a small price table constant" — this is approximate
 *  by design (see the HUD tooltip copy in AgentRosterCard.tsx) and does not
 *  attempt to track live pricing changes. */
interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICE_TABLE: readonly [prefix: string, price: ModelPrice][] = [
  ['claude-fable-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-mythos-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-opus-5', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-opus-4', { inputPerMTok: 5, outputPerMTok: 25 }], // 4-8/4-7/4-6
  ['claude-sonnet-5', { inputPerMTok: 2, outputPerMTok: 10 }],
  ['claude-sonnet-4', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-haiku-4-5', { inputPerMTok: 1, outputPerMTok: 5 }]
];
/** Sonnet-tier rate — used when `model` is unset or unrecognized (a future
 *  model id, or a legacy one this table doesn't carry). */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

/** Cache-token cost multipliers relative to the model's INPUT rate — per the
 *  claude-api skill's own documented approximations ("~1.25x cost" for a
 *  cache write, "~0.1x cost" for a cache read), not a guess. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function isPlaceholderModel(model: string | null): boolean {
  return model !== null && /^<[^>]+>$/.test(model);
}

function priceForModel(model: string | null): ModelPrice {
  if (!model) return FALLBACK_PRICE;
  for (const [prefix, price] of PRICE_TABLE) {
    if (model.startsWith(prefix)) return price;
  }
  return FALLBACK_PRICE;
}

/** Context-window size per model, for the HUD's occupancy fraction. Table
 *  entries reflect the claude-api skill's cached model table (mostly 1M
 *  tokens on current models); FALLBACK_WINDOW is deliberately the smaller,
 *  conservative 200K figure (Haiku 4.5's window, and the long-standing
 *  default for older/legacy models) — understating headroom reads as "closer
 *  to full" than reality, which is the safer wrong guess for an "approximate"
 *  gauge than the reverse. */
const CONTEXT_WINDOW_TABLE: readonly [prefix: string, window: number][] = [
  ['claude-fable-5', 1_000_000],
  ['claude-mythos-5', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-opus-4', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-sonnet-4', 1_000_000],
  ['claude-haiku-4-5', 200_000]
];
const FALLBACK_WINDOW = 200_000;

function windowForModel(model: string | null): number {
  if (!model) return FALLBACK_WINDOW;
  for (const [prefix, window] of CONTEXT_WINDOW_TABLE) {
    if (model.startsWith(prefix)) return window;
  }
  return FALLBACK_WINDOW;
}

interface TrackedSession {
  path: string;
  /** Byte offset already consumed. */
  offset: number;
  /** Trailing partial line from the last read, prefixed onto the next one. */
  carry: string;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCostUsd: number;
  lastContextTokens: number;
  lastModel: string | null;
}

export class CostWatcher {
  private sessions = new Map<string, TrackedSession>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private getWebContents: () => WebContents | null) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollAll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Register (or no-op if already registered) a session's transcript path.
   *  Safe to call repeatedly/redundantly — see this file's header. Does an
   *  immediate full-file parse so the HUD has numbers before the first
   *  POLL_MS tick, then only tails on subsequent polls. */
  registerSession(agentId: string, transcriptPath: string | undefined | null): void {
    if (!transcriptPath || this.sessions.has(agentId)) return;
    this.sessions.set(agentId, {
      path: transcriptPath,
      offset: 0,
      carry: '',
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUsd: 0,
      lastContextTokens: 0,
      lastModel: null
    });
    this.pollOne(agentId);
  }

  unregisterSession(agentId: string): void {
    this.sessions.delete(agentId);
  }

  /** Hook payload observer — see hookBridge.ts's `onRawPayload` constructor
   *  param. Registers off whatever payload carries a transcript path;
   *  everything else about the payload is irrelevant here. */
  onHookPayload(agentId: string, transcriptPath: string | undefined): void {
    this.registerSession(agentId, transcriptPath);
  }

  private pollAll(): void {
    for (const id of this.sessions.keys()) this.pollOne(id);
  }

  private pollOne(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;

    let size: number;
    try {
      size = statSync(s.path).size;
    } catch {
      return; // not written yet, or gone — retry next tick
    }
    if (size < s.offset) {
      // Rotated/truncated — restart from scratch rather than reading garbage,
      // including the cumulative counters (a shrunk file means the earlier
      // totals no longer describe what's actually in it).
      s.offset = 0;
      s.carry = '';
      s.cumulativeInputTokens = 0;
      s.cumulativeOutputTokens = 0;
      s.cumulativeCostUsd = 0;
      s.lastContextTokens = 0;
      s.lastModel = null;
    }
    if (size === s.offset) return; // nothing new

    let fd: number;
    try {
      fd = openSync(s.path, 'r');
    } catch {
      return;
    }
    try {
      const len = size - s.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, s.offset);
      s.offset = size;
      const chunk = s.carry + buf.toString('utf8');
      const lines = chunk.split('\n');
      s.carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.applyLine(s, line);
      }
    } finally {
      closeSync(fd);
    }

    this.emit(agentId, s);
  }

  private applyLine(s: TrackedSession, line: string): void {
    let entry: {
      type?: string;
      isSidechain?: boolean;
      message?: { model?: string; usage?: Record<string, number> };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return; // a torn line read mid-write — will re-parse cleanly once complete
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) return;
    const usage = entry.message?.usage;
    if (!usage) return;

    const parsedModel = entry.message?.model ?? null;
    // Claude Code uses angle-bracketed internal model ids for placeholder
    // entries; they must not replace the session's last real model.
    const model = isPlaceholderModel(parsedModel) ? s.lastModel : parsedModel;
    const inputTok = usage.input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const outputTok = usage.output_tokens ?? 0;
    const turnContextTokens = inputTok + cacheCreate + cacheRead;

    s.cumulativeInputTokens += turnContextTokens;
    s.cumulativeOutputTokens += outputTok;
    s.lastContextTokens = turnContextTokens;
    s.lastModel = model;

    const price = priceForModel(model);
    s.cumulativeCostUsd +=
      (inputTok * price.inputPerMTok +
        cacheCreate * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
        cacheRead * price.inputPerMTok * CACHE_READ_MULTIPLIER +
        outputTok * price.outputPerMTok) /
      1_000_000;
  }

  private emit(agentId: string, s: TrackedSession): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    const update: SessionCostUpdate = {
      inputTokens: s.cumulativeInputTokens,
      outputTokens: s.cumulativeOutputTokens,
      costUsd: s.cumulativeCostUsd,
      contextTokens: s.lastContextTokens,
      contextWindow: windowForModel(s.lastModel),
      model: s.lastModel
    };
    try {
      wc.send(`cost:update:${agentId}`, update);
    } catch {
      /* window tore down mid-send */
    }
  }
}
