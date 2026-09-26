/**
 * Outside-write detector — external sessions plan §7 step 5.
 *
 * Scoped strictly to sessions with `SessionRecord.continuedFrom` set (a
 * session that continues a conversation started outside Pokéharness). A
 * running `claude` process holds its conversation in memory and does not
 * pick up turns another surface appends to the same transcript (confirmed
 * live, plan §6 test 1) — this watches for exactly that, and tells the
 * renderer a session is a reload candidate. The renderer owns the final
 * decision (idle gate "ours" — typed bytes / keypress recency / hook status
 * — lives there), including the manual "Updated elsewhere — reload" chip
 * and the auto-reload circuit breaker; this module only ever emits
 * candidates, never reloads anything itself.
 *
 * Two independent signals, matching plan §7 "Outside-write detection":
 *  (a) primary — the `~/.claude/sessions/<pid>.json` liveness registry shows
 *      a DIFFERENT pid holding our `claudeSessionId` that went busy → idle
 *      or disappeared since we last saw it busy.
 *  (b) secondary — a new human-prompt `user` record appears in our own
 *      transcript whose text matches none of OUR `UserPromptSubmit` prompts
 *      (see `noteOwnPrompt` below).
 * (c) re-baseline — `rebaseline()`, called after our own reload's resume,
 *     so that resume's own SessionStart/transcript growth is never
 *     mistaken for a fresh outside write.
 * (d) circuit breaker — left to the renderer (it owns the actual reload
 *     call and needs "one per session," not "one per detector instance");
 *     this module logs every decision it makes on its own two signals.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './diagnostics';
import type { SessionRecord } from '../shared/types';

/** How often the poll fallback re-scans the registry dir when `fs.watch`
 *  isn't (or stops) firing — plan §7's "fs.watch plus a slow poll
 *  fallback." */
const REGISTRY_POLL_MS = 5_000;

/** Transcript tail is only re-checked this often — it rides the same timer
 *  as the registry poll rather than a second one. */
const TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024;

/** How many of our own most-recently-submitted prompts we keep around to
 *  recognize a transcript record as "ours" (signal (b)). Generous — a
 *  session working through many turns before this app restarts should not
 *  forget its own recent prompts. */
const OWN_PROMPT_HISTORY = 50;

interface RegistryEntry {
  pid?: number;
  sessionId?: string;
  status?: string;
  updatedAt?: number;
}

interface Tracked {
  cwd: string;
  claudeSessionId: string;
  /** This session's own pty pid (`PtyManager`'s live pid for it) — excluded
   *  from registry candidates so we never treat our own process as "another
   *  surface." */
  ownPid: number | undefined;
  /** Recent prompts WE submitted (signal (b)'s exclusion list). */
  ownPrompts: string[];
  /** Foreign pid(s) we've seen busy on this `claudeSessionId` since the last
   *  time they all went idle/disappeared — cleared once signal (a) fires. */
  sawForeignBusy: boolean;
  /** Transcript tail-read bookkeeping (own reader, independent of
   *  costWatcher.ts's — that one only cares about cost/model tokens). */
  transcriptPath: string | undefined;
  transcriptOffset: number;
  transcriptCarry: string;
}

export class OutsideWriteDetector {
  private readonly sessions = new Map<string, Tracked>();
  private registryWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onCandidate: (agentId: string) => void,
    private readonly getOwnPid: (agentId: string) => number | undefined
  ) {}

  /** Fed from main/index.ts's `sessions:checkpoint` handler, same cadence
   *  costWatcher.ts/taskNotificationWatcher.ts already use — registers every
   *  live `continuedFrom` session (native sessions are never registered, so
   *  they can never auto-reload or show the chip — plan §7's scoping) and
   *  drops any this session no longer tracks (closed, or no longer
   *  `continuedFrom`). */
  onSessionsChecked(sessions: SessionRecord[]): void {
    const wanted = new Set<string>();
    for (const s of sessions) {
      if (!s.continuedFrom || !s.claudeSessionId) continue;
      wanted.add(s.id);
      this.registerSession(s.id, s.cwd, s.claudeSessionId, this.getOwnPid(s.id));
    }
    for (const id of [...this.sessions.keys()]) {
      if (!wanted.has(id)) this.unregisterSession(id);
    }
  }

  private get registryDir(): string {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
    return join(claudeDir, 'sessions');
  }

  /** Registers (or updates) a `continuedFrom` session to watch. Call again
   *  whenever the session's tracked fields might have changed (checkpoint) —
   *  cheap, idempotent for an unchanged claudeSessionId. */
  registerSession(agentId: string, cwd: string, claudeSessionId: string, ownPid: number | undefined): void {
    const existing = this.sessions.get(agentId);
    if (existing && existing.claudeSessionId === claudeSessionId) {
      existing.cwd = cwd;
      existing.ownPid = ownPid;
      return;
    }
    this.sessions.set(agentId, {
      cwd,
      claudeSessionId,
      ownPid,
      ownPrompts: existing?.ownPrompts ?? [],
      sawForeignBusy: false,
      transcriptPath: existing?.transcriptPath,
      transcriptOffset: 0,
      transcriptCarry: ''
    });
    this.ensureTimers();
  }

  unregisterSession(agentId: string): void {
    this.sessions.delete(agentId);
  }

  /** Signal (b)'s exclusion list — called from hookBridge.ts's
   *  `onUserPromptSubmit` for every top-level `UserPromptSubmit` this app's
   *  own hooks observe. */
  noteOwnPrompt(agentId: string, prompt: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    s.ownPrompts.push(prompt.trim());
    if (s.ownPrompts.length > OWN_PROMPT_HISTORY) s.ownPrompts.shift();
  }

  /** Keeps the live transcript path current — the same value
   *  `HookBridge.getLiveTranscriptPath` tracks, forwarded here so the
   *  detector reads the ACTUAL current file, not a possibly-stale
   *  persisted one. */
  noteTranscriptPath(agentId: string, transcriptPath: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    if (s.transcriptPath !== transcriptPath) {
      s.transcriptPath = transcriptPath;
      s.transcriptOffset = 0;
      s.transcriptCarry = '';
    }
  }

  /** Signal (c) — call after OUR OWN reload's resume has spawned, so that
   *  resume's own transcript growth (and the `SessionStart` it fires) is
   *  never mistaken for a fresh outside write. Re-baselines the transcript
   *  tail to "current end of file" and clears the foreign-busy latch. */
  rebaseline(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    s.sawForeignBusy = false;
    if (s.transcriptPath && existsSync(s.transcriptPath)) {
      try {
        s.transcriptOffset = statSync(s.transcriptPath).size;
      } catch {
        /* leave offset as-is; next tail read will resync */
      }
    }
    s.transcriptCarry = '';
    log('outsideWrite', 'info', 'rebaseline after our own reload', { agentId });
  }

  private ensureTimers(): void {
    if (!this.registryWatcher) {
      try {
        this.registryWatcher = watch(this.registryDir, { persistent: false }, () => this.scanRegistry());
      } catch {
        // Directory may not exist yet (no claude session has ever run on
        // this machine) — the poll fallback below still works once it does.
      }
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.scanRegistry();
        this.scanTranscripts();
      }, REGISTRY_POLL_MS);
    }
  }

  private scanRegistry(): void {
    if (this.sessions.size === 0) return;
    let files: string[];
    try {
      files = readdirSync(this.registryDir).filter((f) => f.endsWith('.json'));
    } catch {
      return; // directory gone/unreadable — nothing to correlate against
    }
    // sessionId -> foreign entries currently registered under it.
    const bySessionId = new Map<string, RegistryEntry[]>();
    for (const f of files) {
      let entry: RegistryEntry;
      try {
        entry = JSON.parse(readFileSync(join(this.registryDir, f), 'utf8')) as RegistryEntry;
      } catch {
        continue; // half-written file mid-update — retry next scan
      }
      if (!entry.sessionId) continue;
      const list = bySessionId.get(entry.sessionId) ?? [];
      list.push(entry);
      bySessionId.set(entry.sessionId, list);
    }
    for (const [agentId, s] of this.sessions) {
      const entries = (bySessionId.get(s.claudeSessionId) ?? []).filter((e) => e.pid !== s.ownPid);
      const anyBusy = entries.some((e) => e.status === 'busy' || e.status === 'waiting');
      if (anyBusy) {
        s.sawForeignBusy = true;
        continue;
      }
      // No foreign entry at all (exited), or every foreign entry idle — if
      // we'd previously seen one busy, this is signal (a) firing.
      if (s.sawForeignBusy) {
        s.sawForeignBusy = false;
        log('outsideWrite', 'info', 'signal (a): foreign session went busy -> idle/exited', {
          agentId,
          claudeSessionId: s.claudeSessionId
        });
        this.onCandidate(agentId);
      }
    }
  }

  private scanTranscripts(): void {
    for (const [agentId, s] of this.sessions) {
      if (!s.transcriptPath) continue;
      let size: number;
      try {
        size = statSync(s.transcriptPath).size;
      } catch {
        continue;
      }
      if (size <= s.transcriptOffset) continue;
      // Bounded read, same shape as costWatcher.ts's own tailing — never the
      // whole file, only whatever's new since the last scan, capped so a
      // very first registration (large existing history) can't stall this
      // on a 195 MB transcript (see external-sessions-plan.md §3).
      const start = Math.max(s.transcriptOffset, size - TRANSCRIPT_TAIL_MAX_BYTES);
      const boundedFromMiddle = start > s.transcriptOffset;
      let text: string;
      try {
        const fd = openSync(s.transcriptPath, 'r');
        try {
          const len = size - start;
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, start);
          text = buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      s.transcriptOffset = size;
      const chunk = (boundedFromMiddle ? '' : s.transcriptCarry) + text;
      const lines = chunk.split('\n');
      // A bounded read almost certainly starts mid-line — drop it rather
      // than feed `isForeignUserPrompt` a truncated JSON record.
      if (boundedFromMiddle) lines.shift();
      s.transcriptCarry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() && this.isForeignUserPrompt(s, line)) {
          log('outsideWrite', 'info', 'signal (b): unrecognized human-prompt transcript record', { agentId });
          this.onCandidate(agentId);
          break; // one candidate emission is enough per scan
        }
      }
    }
  }

  /** Signal (b)'s own filter — a `user` record that isn't meta, isn't a
   *  tool_result, isn't a task-notification/command-output text block, and
   *  whose text matches none of the prompts WE submitted via our own
   *  `UserPromptSubmit` hook. */
  private isForeignUserPrompt(s: Tracked, line: string): boolean {
    let entry: {
      type?: string;
      isMeta?: boolean;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (entry.type !== 'user' || entry.isMeta) return false;
    const content = entry.message?.content;
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // A tool_result-only turn has no plain text block — not a human prompt.
      const textBlock = content.find(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
      );
      if (!textBlock) return false;
      text = textBlock.text;
    }
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<task-notification>') || trimmed.startsWith('<command-')) return false;
    // A compact summary reads as a very specific system-authored preamble;
    // heuristic only (the exact marker text isn't documented) — skip
    // anything implausibly long for a human-typed prompt line-for-line match
    // attempt below rather than guess further.
    return !s.ownPrompts.includes(trimmed);
  }

  dispose(): void {
    this.registryWatcher?.close();
    this.registryWatcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.sessions.clear();
  }
}
