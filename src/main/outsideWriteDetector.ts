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
import { dirname, join } from 'node:path';
import { log } from './diagnostics';
import { claudeSessionIdFromTranscriptPath } from './hookBridge';
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

/** D5 — "theirs" half of the idle gate for signal (b): a foreign write is
 *  only trusted once the transcript file itself has been quiet this long,
 *  so a candidate never fires while the other surface's turn is still
 *  actively streaming into the file. */
const TRANSCRIPT_QUIET_MS = 4_000;

interface RegistryEntry {
  pid?: number;
  sessionId?: string;
  status?: string;
  updatedAt?: number;
}

interface Tracked {
  cwd: string;
  claudeSessionId: string;
  /** Recent prompts WE submitted (signal (b)'s exclusion list). */
  ownPrompts: string[];
  /** Foreign pid(s) we've seen busy on this `claudeSessionId` since the last
   *  time they all went idle/disappeared — cleared once signal (a) fires. */
  sawForeignBusy: boolean;
  /** D5 — signal (b) detected a foreign human-prompt record but the "theirs"
   *  gate (no foreign entry busy/waiting, transcript quiet ≥4s) wasn't open
   *  yet. Held here and re-checked on every later scan until it opens,
   *  instead of firing mid-turn. */
  pendingB: boolean;
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
      this.registerSession(s.id, s.cwd, s.claudeSessionId);
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
   *  cheap, idempotent for an unchanged claudeSessionId.
   *
   *  D3 fix: when `claudeSessionId` changes (first registration, Continue,
   *  or a reload/`/clear` under this same agentId), the transcript offset is
   *  seeded to the CURRENT end of whatever file ends up tracked rather than
   *  0 — starting at 0 would re-read up to `TRANSCRIPT_TAIL_MAX_BYTES` of
   *  pre-existing history on the very next scan and misreport all of it as
   *  a fresh outside write, firing a spurious reload after every Continue
   *  and every app restart.
   *
   *  Re-review item 4 fix: on an id change, the OLD `transcriptPath` is
   *  never just carried over as-is — it names the PRE-change conversation
   *  (a `/clear` opens a brand-new file in the same project directory).
   *  `noteTranscriptPath` also normally corrects this once the matching
   *  `SessionStart(clear)` hook's `transcript_path` arrives, but that update
   *  can lose the race against THIS call: the hook fires synchronously
   *  main-side (`index.ts`'s `onRawPayload` -> `noteTranscriptPath`),
   *  usually well before the renderer's `hookRouter.ts` has processed the
   *  same event, updated the store, and round-tripped a checkpoint back to
   *  main (`onSessionsChecked` -> here) — so `noteTranscriptPath` typically
   *  runs FIRST, while `s.claudeSessionId` is STILL the old id, and its own
   *  basename-must-match guard (see that function's comment) rejects the
   *  new path outright. By the time THIS call finally updates
   *  `claudeSessionId`, the correct path has already been dropped, and
   *  nothing else was ever going to re-offer it. So: on an id change, if an
   *  old path is tracked, rebuild it as `<same dir>/<newId>.jsonl` (a
   *  `/clear` never changes the project directory) and seed the offset from
   *  its size if it happens to exist yet, else 0 — never carry the OLD path
   *  forward under the NEW id. */
  registerSession(agentId: string, cwd: string, claudeSessionId: string): void {
    const existing = this.sessions.get(agentId);
    if (existing && existing.claudeSessionId === claudeSessionId) {
      existing.cwd = cwd;
      return;
    }
    let transcriptPath = existing?.transcriptPath;
    let transcriptOffset = 0;
    if (transcriptPath) {
      const rebuilt = join(dirname(transcriptPath), `${claudeSessionId}.jsonl`);
      transcriptPath = rebuilt;
      try {
        transcriptOffset = statSync(rebuilt).size;
      } catch {
        transcriptOffset = 0; // doesn't exist YET — the next scan/hook will catch it once it does
      }
    }
    this.sessions.set(agentId, {
      cwd,
      claudeSessionId,
      ownPrompts: existing?.ownPrompts ?? [],
      sawForeignBusy: false,
      pendingB: false,
      transcriptPath,
      transcriptOffset,
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

  /** Keeps the tracked transcript path current — forwarded from main's own
   *  live-hook observation (index.ts's `onRawPayload`), NOT trusted blindly:
   *  D13 — a nested `claude -p` run inherits this session's own
   *  `POKEHARNESS_AGENT_ID` and fires its own top-level-shaped hooks, which
   *  would otherwise point this detector at the nested run's unrelated
   *  transcript. Only accepted when its basename actually matches the
   *  claudeSessionId we're tracking for this session (kept current by the
   *  revived `/clear` fix + hookRouter.ts's nested-startup guard), the same
   *  invariant `sessions:reload` now leans on instead of a separate
   *  live-path override.
   *
   *  D3 fix: a path change (including the very first one) seeds the offset
   *  to the file's CURRENT size, never 0 — see `registerSession`'s own
   *  comment for why 0 would misreport pre-existing history as new. */
  noteTranscriptPath(agentId: string, transcriptPath: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    if (claudeSessionIdFromTranscriptPath(transcriptPath) !== s.claudeSessionId) return;
    if (s.transcriptPath === transcriptPath) return;
    s.transcriptPath = transcriptPath;
    try {
      s.transcriptOffset = statSync(transcriptPath).size;
    } catch {
      s.transcriptOffset = 0;
    }
    s.transcriptCarry = '';
  }

  /** Signal (c) — call after OUR OWN reload's resume has spawned, so that
   *  resume's own transcript growth (and the `SessionStart` it fires) is
   *  never mistaken for a fresh outside write. Re-baselines the transcript
   *  tail to "current end of file" and clears the foreign-busy latch. */
  rebaseline(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    s.sawForeignBusy = false;
    s.pendingB = false;
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
        this.registryWatcher = watch(this.registryDir, { persistent: false }, () => this.scanAll());
      } catch {
        // Directory may not exist yet (no claude session has ever run on
        // this machine) — the poll fallback below still works once it does.
      }
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.scanAll(), REGISTRY_POLL_MS);
    }
  }

  /** Whether pid `pid` still names a live process. Used both to exclude a
   *  dead registry entry from "foreign" candidates (D8 — a stale/orphaned
   *  `<pid>.json` the CLI never cleaned up must not look like a live foreign
   *  surface) and, trivially, our own (also checked fresh, not cached — see
   *  `scanAll`'s own comment). `process.kill(pid, 0)` sends no signal, only
   *  probes; ESRCH means dead, EPERM means alive-but-unowned (still counts
   *  as alive here). */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  /** One combined tick: registry scan (signal a) and transcript scan
   *  (signal b), then a pending-(b)-latch reconciliation — all sharing the
   *  same freshly-read registry snapshot, since D5's "theirs" gate for (b)
   *  needs the SAME busy/waiting check (a) already computes. */
  private scanAll(): void {
    if (this.sessions.size === 0) return;
    let files: string[];
    try {
      files = readdirSync(this.registryDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = []; // directory gone/unreadable — treat as "nothing foreign registered"
    }
    // sessionId -> live foreign entries currently registered under it.
    const bySessionId = new Map<string, RegistryEntry[]>();
    for (const f of files) {
      let entry: RegistryEntry;
      try {
        entry = JSON.parse(readFileSync(join(this.registryDir, f), 'utf8')) as RegistryEntry;
      } catch {
        continue; // half-written file mid-update — retry next scan
      }
      if (!entry.sessionId || typeof entry.pid !== 'number' || entry.pid <= 1) continue; // pid<=1 is never real
      if (!this.isPidAlive(entry.pid)) continue; // D8 — a dead pid's stale registry file
      const list = bySessionId.get(entry.sessionId) ?? [];
      list.push(entry);
      bySessionId.set(entry.sessionId, list);
    }

    for (const [agentId, s] of this.sessions) {
      // D8 — fetched fresh every scan, never cached: after a reload, this
      // session's OWN pid changes, and a cached pre-reload pid would make
      // our own new process look foreign to itself, firing another reload
      // immediately.
      const ownPid = this.getOwnPid(agentId);
      const foreignEntries = (bySessionId.get(s.claudeSessionId) ?? []).filter((e) => e.pid !== ownPid);
      const anyForeignBusy = foreignEntries.some((e) => e.status === 'busy' || e.status === 'waiting');

      // Signal (a) — foreign went busy -> idle/exited. Already implies
      // "theirs" is idle (that's the transition being detected), so this
      // fires immediately, same as before.
      let firedA = false;
      if (anyForeignBusy) {
        s.sawForeignBusy = true;
      } else if (s.sawForeignBusy) {
        s.sawForeignBusy = false;
        firedA = true;
        log('outsideWrite', 'info', 'signal (a): foreign session went busy -> idle/exited', {
          agentId,
          claudeSessionId: s.claudeSessionId
        });
        this.onCandidate(agentId);
      }

      // Signal (b) — scan the transcript tail for a new foreign human
      // prompt; latch it as pending rather than firing yet (D5). Run even
      // when (a) just fired, so the offset still advances — but see below.
      this.scanTranscriptFor(agentId, s);

      // Re-review item 5 — (a) and (b) can both detect the SAME foreign
      // turn (the busy->idle transition (a) reacts to is usually exactly
      // the turn whose transcript record (b) would also notice). Cleared
      // AFTER `scanTranscriptFor` above (which may have just SET it for
      // this very turn) rather than before it: clearing it earlier would
      // only suppress a stale latch from a PRIOR tick, not the one this
      // tick's scan is about to raise for the turn (a) just reported.
      // Without this, (b)'s own candidate for the same turn fires shortly
      // after this one, hits the renderer's circuit breaker (one
      // auto-reload per 3 minutes), and gets stuck showing the chip for the
      // rest of that window instead of clearing.
      if (firedA) s.pendingB = false;

      // D5 — reconcile any pending (b): only fires once NEITHER side is
      // mid-turn — no foreign entry busy/waiting, AND our transcript file
      // itself has been quiet for TRANSCRIPT_QUIET_MS (a reload mid-tool-
      // call can otherwise write repair records right as we'd fire).
      if (s.pendingB) {
        if (anyForeignBusy) continue;
        const quiet = s.transcriptPath ? this.transcriptQuietFor(s.transcriptPath) : true;
        if (!quiet) continue;
        s.pendingB = false;
        log('outsideWrite', 'info', 'signal (b): gate opened, firing held candidate', { agentId });
        this.onCandidate(agentId);
      }
    }
  }

  /** How long (ms) since `transcriptPath` was last written — `Infinity` if
   *  it can't be stat'd (treated as "quiet"; nothing here to wait on). */
  private transcriptQuietFor(transcriptPath: string): boolean {
    try {
      return Date.now() - statSync(transcriptPath).mtimeMs >= TRANSCRIPT_QUIET_MS;
    } catch {
      return true;
    }
  }

  private scanTranscriptFor(agentId: string, s: Tracked): void {
    if (!s.transcriptPath) return;
    let size: number;
    try {
      size = statSync(s.transcriptPath).size;
    } catch {
      return;
    }
    if (size <= s.transcriptOffset) return;
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
      return;
    }
    s.transcriptOffset = size;
    const chunk = (boundedFromMiddle ? '' : s.transcriptCarry) + text;
    const lines = chunk.split('\n');
    // A bounded read almost certainly starts mid-line — drop it rather than
    // feed `isForeignUserPrompt` a truncated JSON record.
    if (boundedFromMiddle) lines.shift();
    s.transcriptCarry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() && this.isForeignUserPrompt(s, line)) {
        if (!s.pendingB) {
          s.pendingB = true;
          log('outsideWrite', 'info', 'signal (b): unrecognized human-prompt record — held pending gate', {
            agentId
          });
        }
        break; // one detection per scan is enough to latch pendingB
      }
    }
  }

  /** Signal (b)'s own filter — a `user` record that isn't meta, isn't a
   *  compact summary, isn't tool-result-only, isn't one of our own
   *  session's various non-human-prompt self-writes, and whose text matches
   *  none of the prompts WE submitted via our own `UserPromptSubmit` hook.
   *
   *  D4 fix — the exclusions below are exact, not a length heuristic (the
   *  previous comment here described a heuristic the code never actually
   *  had): `isCompactSummary`/`isVisibleInTranscriptOnly` are skipped by
   *  field, and text starting with `<` (covers `<task-notification>`,
   *  `<command-…>`, and OUR OWN `<local-command-stdout>`/`<bash-input>`/
   *  `<bash-stdout>` records from `/model`, `/cost`, `/clear`, and `!`
   *  shell commands) or `[Request interrupted` (an Esc-interrupt record) is
   *  skipped too — all of those are records this SAME session's own CLI
   *  writes for itself, never a foreign human prompt. */
  private isForeignUserPrompt(s: Tracked, line: string): boolean {
    let entry: {
      type?: string;
      isMeta?: boolean;
      isCompactSummary?: boolean;
      isVisibleInTranscriptOnly?: boolean;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) {
      return false;
    }
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
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[Request interrupted')) return false;
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
