/**
 * TaskNotificationWatcher — Bug B fix (2026-08-29): a real, per-subagent
 * completion signal for ASYNC `Task`/`Agent` dispatches, read from the
 * parent session's own transcript. Same tailing mechanism as costWatcher.ts/
 * arceusRelay.ts (poll by byte offset, carry a torn trailing line to the next
 * poll, restart from scratch if the file shrinks) — see costWatcher.ts's
 * header for why polling instead of `fs.watch`.
 *
 * WHY THIS EXISTS: BattleManager.ts's `handleParentDone` (fed by hookRouter's
 * `Stop` case) assumed a `Task` tool call blocks the parent's own turn until
 * it genuinely completes — false for an ASYNC dispatch, which is what every
 * live-captured `Agent` tool call in this app's own transcripts turned out to
 * be (see below). `Stop` can fire ~100-200ms after an async dispatch, while
 * the real subagent keeps working for minutes — exactly the live production
 * bug this fixes (harness.log, 2026-08-28T23:37:20Z: a battler's completion
 * battle fired ~100s after spawn while its subagent kept working for ~10
 * more minutes).
 *
 * EVIDENCE (real `claude` CLI 2.1.248, captured via a headless `-p` spawn
 * using this app's own production HookBridge — see the scratchpad's
 * hooktest/ directory, result-session2.json / result-session3.json /
 * debug-session2.log / debug-session3.log, and the transcripts they produced
 * under ~/.claude/projects/-private-tmp-...-hooktest-workdir/*.jsonl):
 *
 * 1. Every `Agent` tool_use in TWO independent live spawns returned
 *    `toolUseResult: { isAsync: true, status: "async_launched", agentId:
 *    "<hex>", ... }` as a sibling field on the `type: "user"` transcript
 *    entry holding that tool call's `tool_result` — a reliable, structured
 *    "this dispatch is async" marker with the CLI's own internal id for it,
 *    available the moment PostToolUse fires (no live evidence a synchronous
 *    Agent/Task dispatch exists at all in this CLI version — matches this
 *    app's own prior conclusion, restated in BattleManager.ts's header).
 * 2. When that async subagent later stops, the CLI enqueues and then injects
 *    a synthetic turn into the PARENT's own transcript:
 *      `type: "user"`, `message.content` (a plain string in both captures) =
 *      `<task-notification><task-id>AGENT_ID</task-id>...<status>completed
 *      </status>...</task-notification>`
 *    — `<task-id>` exactly matches the earlier `toolUseResult.agentId`
 *    (verified byte-for-byte in both captures). This IS the "task-id
 *    carrying transcript notification" this app's own investigation
 *    hypothesized, now confirmed on disk.
 * 3. That injection fires a real `UserPromptSubmit` hook for the PARENT
 *    session, and a real `SubagentStop` fires too — CONTRADICTING this
 *    codebase's prior (unverified) comments claiming neither ever arrives.
 *    Left uncorrected in hookRouter.ts's `SubagentStop` case is still the
 *    right call, though: `SubagentStop`'s own `harness_agent_id` tagging was
 *    NOT reliable across the two captures — session3 tagged it with the
 *    PARENT's own harness agentId, session2 tagged it with the CLI's
 *    internal subagent id instead (routing that event to an IPC channel no
 *    renderer listens on — see hookBridge.ts's per-agentId `wc.send`). This
 *    watcher reads the TRANSCRIPT instead specifically to sidestep that
 *    inconsistency.
 * 4. CAVEAT (see the report to the orchestrator, and BattleManager.ts's own
 *    header): both captures used `claude -p` (headless, single-process,
 *    non-interactive) — the same mode as this app's real interactive pty
 *    spawn for the HOOKS/transcript MECHANISM (same HookBridge, same shim,
 *    same on-disk transcript format), but NOT necessarily for the TIMING of
 *    when a completed async task's notification gets delivered into an
 *    otherwise-idle parent transcript. `-p` mode had a live turn loop
 *    driving delivery; whether an interactive session idling at its prompt
 *    still gets the notification appended promptly (rather than only on the
 *    user's next real prompt) is unverified — this app is never allowed to
 *    spawn a real interactive `claude` session to check (see hookRouter.ts).
 *    If it turns out notifications only land on the next real prompt, this
 *    watcher still isn't wrong to trust when it DOES see one — it just may
 *    fire later than a live-interactive user would expect. Degrades to the
 *    existing WAVE watchdogs/global queue (nothing wedges); the affected
 *    battler just roams longer, which is the documented "late is fine, early
 *    is not" tradeoff this whole feature is already built around.
 *
 * WHAT THIS WATCHER DOES: for every registered parent transcript, counts
 * outstanding async launches (`toolUseResult.isAsync`) minus terminally-
 * notified ones (deduped by `<task-id>`, since the CLI's own note text warns
 * "the same task-id may notify more than once" if a finished async agent is
 * later resumed) and reports both halves to the renderer:
 *   - `battle:asyncLaunch` (agentId) — one more async subagent outstanding
 *     for this parent. hookRouter.ts uses the running count this produces to
 *     GATE `Stop`-driven completion (`handleParentDone`) — Stop only queues a
 *     roaming sub when the count is zero, i.e. nothing async is known to
 *     still be in flight for that parent. A genuinely synchronous dispatch
 *     (if one exists) never triggers this event at all, so `Stop` keeps
 *     concluding it exactly as before this fix.
 *   - `battle:subagentTaskNotification` (agentId, taskId) — a real completion
 *     (whatever its `<status>` — a failed/cancelled subagent is still done,
 *     so this deliberately does NOT require `<status>completed</status>`).
 *     hookRouter.ts forwards this straight into the existing `'end'` battle
 *     signal, now carrying the exact CLI-internal task-id so
 *     `BattleManager.handleEnd` can retire the battler actually stamped with
 *     it, falling back to the old "queue the oldest roaming sub for this
 *     parent" heuristic only when no battler was ever stamped (see the
 *     battler ↔ task-id correlation fix below).
 *   - `battle:taskCorrelated` (agentId, toolUseId, taskId) — battler ↔
 *     task-id correlation (2026-08-29 fix): links a dispatch's `tool_use_id`
 *     (known at PreToolUse, carried through the `spawn` battle signal — see
 *     battleBus.ts) to the CLI-internal task-id this file reads off the same
 *     async-launch transcript entry (`extractToolUseId`). BattleManager's
 *     `handleCorrelate` either stamps the battler that dispatch already
 *     spawned, or — if no live battler carries that `tool_use_id` — treats it
 *     as a RESUME (the same task-id dispatched async again after its earlier
 *     battler fully faded) and re-materializes one from remembered species/
 *     label. The RESUME half only works because a task-id already sitting in
 *     `notified` (its prior completion fully consumed) is un-guarded the
 *     moment it launches async again, above — otherwise the resumed run's own
 *     completion would be silently deduped and the re-materialized battler
 *     would roam forever (BACKLOG "resumed agents are invisible").
 *
 * Sidechain-excluded (`isSidechain: true`) same as costWatcher.ts/
 * arceusRelay.ts's own exclusion — those entries belong to a SUBAGENT's own
 * nested interleaving (e.g. a subagent that itself dispatches a nested
 * agent); this app spawns no battler for a grandchild, so a notification
 * living only on a sidechain must never surface here.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { WebContents } from 'electron';

const POLL_MS = 2_000;

/** `message.content` on a transcript entry is either a plain string (both
 *  real captures — the task-notification injection) or an array of content
 *  blocks (costWatcher.ts/arceusRelay.ts's own header notes this shape is
 *  untyped upstream, and arceusRelay.ts's `extractAssistantText` already
 *  handles the array form for assistant replies) — handled the same way here
 *  defensively, even though only the string form has been observed for a
 *  task-notification injection specifically. */
export function extractUserContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** Every `<task-notification>...<task-id>ID</task-id>...</task-notification>`
 *  block's id, in order. Deliberately does NOT look at `<status>` — a
 *  failed/cancelled subagent still fires this, and treating only "completed"
 *  as terminal would leave that battler roaming forever on failure. */
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<task-id>([^<]*)<\/task-id>[\s\S]*?<\/task-notification>/g;

export function extractTaskNotificationIds(text: string): string[] {
  if (!text.includes('<task-notification>')) return [];
  const ids: string[] = [];
  TASK_NOTIFICATION_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = TASK_NOTIFICATION_RE.exec(text)) !== null; ) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  toolUseResult?: { isAsync?: boolean; agentId?: string };
  message?: { content?: unknown };
}

/** True + the CLI's internal task id when `line` is an async-launch entry
 *  (`toolUseResult.isAsync === true`) — pulled out as a pure helper alongside
 *  `extractTaskNotificationIds` so both halves of the detector are testable
 *  without a live transcript. */
export function extractAsyncLaunchId(entry: TranscriptEntry): string | null {
  const tur = entry.toolUseResult;
  if (tur && tur.isAsync === true && typeof tur.agentId === 'string' && tur.agentId) return tur.agentId;
  return null;
}

/** The `tool_use_id` off the `tool_result` content block sibling to
 *  `toolUseResult` on the SAME transcript entry an async launch is detected
 *  from — Anthropic's own tool_use/tool_result correlation id, matching the
 *  `tool_use_id` field Claude Code's PreToolUse/PostToolUse hook payloads
 *  carry for that identical tool call (see shared/hookEvents.ts's
 *  `HookPayload.tool_use_id`). This is the link between a `Task` (or a later
 *  resume/continue call)'s `tool_use_id` — known at PreToolUse, before any
 *  CLI-internal task-id exists — and the `toolUseResult.agentId` this file
 *  already reads, which only shows up here once the dispatch lands in the
 *  transcript. Battler correlation (BattleManager.ts's `handleCorrelate`)
 *  depends on this; if it ever comes back null in practice (transcript shape
 *  differs from the standard tool_use/tool_result layout assumed here —
 *  UNVERIFIED against a live capture, since this app can't spawn a real
 *  interactive `claude` session, see hookRouter.ts), correlation simply never
 *  lands for that dispatch and BattleManager falls back to its pre-existing
 *  oldest-roaming heuristic — nothing breaks, it just degrades to today's
 *  behavior for that one battler. */
export function extractToolUseId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; tool_use_id?: unknown };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id) return b.tool_use_id;
    }
  }
  return null;
}

interface TrackedTranscript {
  path: string;
  /** Byte offset already consumed. */
  offset: number;
  /** Trailing partial line from the last read, prefixed onto the next one. */
  carry: string;
  /** CLI-internal task ids launched async and not yet terminally notified. */
  pending: Set<string>;
  /** CLI-internal task ids already reported terminal — guards the "same
   *  task-id may notify more than once" case (a resumed async agent) from
   *  emitting a second completion for one subagent. */
  notified: Set<string>;
}

export class TaskNotificationWatcher {
  private tracked = new Map<string, TrackedTranscript>();
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

  /** Registers (or no-ops if already registered) a session's transcript
   *  path — idempotent, same as costWatcher.ts's `registerSession`, safe to
   *  call on every hook payload. UNLIKE costWatcher (which replays a
   *  transcript whole because cost aggregation is idempotent to re-derive),
   *  this starts tailing from the file's CURRENT size, same reasoning as
   *  arceusRelay.ts's own `onHookPayload`: a `--resume` respawn points this
   *  at an EXISTING transcript that may carry async launches/notifications
   *  from a previous life, and replaying those would gate/queue off stale
   *  history. A fresh session's transcript is empty at registration time
   *  anyway (SessionStart fires before its first turn), so this only ever
   *  matters for the resume case. */
  registerSession(agentId: string, transcriptPath: string | undefined | null): void {
    if (!transcriptPath || this.tracked.has(agentId)) return;
    let size = 0;
    try {
      size = statSync(transcriptPath).size;
    } catch {
      /* not written yet — starts at 0, nothing to skip */
    }
    this.tracked.set(agentId, {
      path: transcriptPath,
      offset: size,
      carry: '',
      pending: new Set(),
      notified: new Set()
    });
  }

  unregisterSession(agentId: string): void {
    this.tracked.delete(agentId);
  }

  /** Hook payload observer — see hookBridge.ts's `onRawPayload` constructor
   *  param (same chaining point costWatcher.ts/arceusRelay.ts use). */
  onHookPayload(agentId: string, transcriptPath: string | undefined): void {
    this.registerSession(agentId, transcriptPath);
  }

  private pollAll(): void {
    for (const id of this.tracked.keys()) this.pollOne(id);
  }

  private pollOne(agentId: string): void {
    const t = this.tracked.get(agentId);
    if (!t) return;

    let size: number;
    try {
      size = statSync(t.path).size;
    } catch {
      return; // not written yet, or gone — retry next tick
    }
    if (size < t.offset) {
      // Rotated/truncated — restart from scratch rather than reading garbage.
      // pending/notified are left as-is: they track CLI-internal task ids,
      // not byte positions, and a rotation doesn't retroactively un-launch or
      // un-notify anything this watcher already saw.
      t.offset = 0;
      t.carry = '';
    }
    if (size === t.offset) return; // nothing new

    let fd: number;
    try {
      fd = openSync(t.path, 'r');
    } catch {
      return;
    }
    let chunk: string;
    try {
      const len = size - t.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, t.offset);
      t.offset = size;
      chunk = t.carry + buf.toString('utf8');
    } finally {
      closeSync(fd);
    }

    const lines = chunk.split('\n');
    t.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.applyLine(agentId, t, line);
    }
  }

  private applyLine(agentId: string, t: TrackedTranscript, line: string): void {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // a torn line read mid-write — will re-parse cleanly once complete
    }
    // Same exclusion costWatcher.ts/arceusRelay.ts apply: a sidechain entry
    // belongs to a SUBAGENT's own nested interleaving, not this parent.
    if (entry.type !== 'user' || entry.isSidechain === true) return;

    const launchId = extractAsyncLaunchId(entry);
    if (launchId) {
      // RESUME correlation (battler ↔ task-id fix, 2026-08-29): a task-id
      // already sitting in `notified` launching async again means its prior
      // completion was already fully consumed (queued/fought its completion
      // battle — see BattleManager.ts's `handleEnd`) by the time this line
      // was ever written, since transcript lines are only read once (byte-
      // offset tailing, never replayed) — so un-guarding it here can't
      // resurrect an already-handled notification, it only lets the CLI's
      // documented "same task-id may notify more than once" case notify for
      // REAL the next time (the resumed run's own completion). Without this,
      // that second notification would be silently swallowed by the dedupe
      // below and the resumed battler would roam forever (BACKLOG "resumed
      // agents are invisible").
      if (t.notified.has(launchId)) t.notified.delete(launchId);
      t.pending.add(launchId);
      this.emit('battle:asyncLaunch', agentId);

      // Battler ↔ task-id correlation: link this dispatch's tool_use_id
      // (known at PreToolUse, before `launchId` existed) to the CLI-internal
      // task-id now available. Renderer decides what to do with the pair —
      // stamp the matching roaming battler (ordinary case) or re-materialize
      // one from memory (a resume whose battler already faded) — see
      // BattleManager.ts's `handleCorrelate`.
      const toolUseId = extractToolUseId(entry.message?.content);
      if (toolUseId) this.emit('battle:taskCorrelated', agentId, toolUseId, launchId);
    }

    const text = extractUserContentText(entry.message?.content);
    for (const taskId of extractTaskNotificationIds(text)) {
      if (t.notified.has(taskId)) continue; // already-consumed completion for this task-id — dedupe
      t.notified.add(taskId);
      t.pending.delete(taskId);
      this.emit('battle:subagentTaskNotification', agentId, taskId);
    }
  }

  private emit(channel: 'battle:asyncLaunch', agentId: string): void;
  private emit(channel: 'battle:subagentTaskNotification', agentId: string, taskId: string): void;
  private emit(channel: 'battle:taskCorrelated', agentId: string, toolUseId: string, taskId: string): void;
  private emit(channel: string, agentId: string, ...rest: string[]): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(channel, agentId, ...rest);
    } catch {
      /* window tore down mid-send */
    }
  }
}
