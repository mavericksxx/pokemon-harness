/**
 * Claude Code lifecycle hook payload shape and the normalized event the main
 * process forwards to the renderer over `hooks:event:<id>`.
 *
 * Dependency-free (shared by main, preload and renderer) — mirrors the shape
 * munder-difflin's HookServer/HOOK_SHIM use (MIT, Chaitanya Giri), trimmed to
 * the events this app actually wires: PreToolUse, PostToolUse, Stop,
 * SubagentStop, Notification, UserPromptSubmit, SessionStart.
 */

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  // Phase 8.5 Wave B item 4 — fires just before Claude Code compacts the
  // conversation; a post-compact `SessionStart` (source: 'compact') follows.
  // Confirmed present in the installed CLI (2.1.250: `strings` on the binary
  // shows "PreCompact" wired as a real hook type, matching Anthropic's public
  // hooks docs) — not observed from a live session, since this app is never
  // allowed to spawn a real `claude` for testing (see hookRouter.ts).
  | 'PreCompact';

/** Raw JSON the generated shim forwards over the socket — one line, Claude's
 *  own hook payload shape plus the `harness_agent_id` the shim stamps from
 *  env. Deliberately not named `agent_id`: Claude's own hook payloads for a
 *  subagent's (Task tool) tool calls and SubagentStop already carry a
 *  top-level `agent_id` (+ `agent_type`) identifying its *internal* subagent,
 *  unrelated to this app's session id — confirmed live, and it collided when
 *  the shim used that same key. */
export interface HookPayload {
  hook_event_name?: string;
  harness_agent_id?: string | null;
  /** Claude Code's CLI-internal subagent identity. This is deliberately kept
   *  separate from `harness_agent_id`: the latter identifies the parent pty
   *  that owns the renderer channel, while these fields identify the subagent
   *  whose hook is being observed. */
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  source?: string;
  /** Absolute path to this session's own transcript .jsonl — present on the
   *  CLI's real hook payloads (confirmed via the installed binary). Phase
   *  8.5 Wave B item 1's cost/context HUD reads it via HookBridge's
   *  `onRawPayload` constructor param rather than reconstructing the
   *  munged-cwd transcript directory name itself. */
  transcript_path?: string;
  /** Anthropic's own tool_use/tool_result correlation id for this exact tool
   *  invocation (e.g. `toolu_01ABC...`) — confirmed via Claude Code's public
   *  hooks docs (code.claude.com/docs/en/hooks: "The `tool_name`,
   *  `tool_input`, and `tool_use_id` fields are event-specific", with a
   *  worked PreToolUse example showing `tool_use_id` alongside `tool_name`/
   *  `tool_input`), present on both PreToolUse and PostToolUse. NOT the same
   *  id as the CLI-internal subagent `agentId`/task-id that only shows up
   *  later in the parent transcript's `toolUseResult` (taskNotification
   *  Watcher.ts) — this is the standard Anthropic API id that a `tool_use`
   *  content block and its later `tool_result` block both carry, which is
   *  what lets that same watcher link the two together (see its
   *  `extractToolUseId`). Unverified against a live capture of this exact
   *  field name in this app's own transcripts (this app is never allowed to
   *  spawn a real interactive `claude` session — see hookRouter.ts) — trusted
   *  on the strength of the public docs instead. */
  tool_use_id?: string;
  /** External-codex-delegate feature — set only when the hook-invoking
   *  process inherited `POKEHARNESS_DELEGATE_PARENT`/`POKEHARNESS_DELEGATE_
   *  LABEL` from its own env (see hookBridge.ts's HOOK_SHIM). A normal
   *  harness-spawned pty never sets those two vars, so these are only ever
   *  present on a `codex exec` the orchestrator launched with them set.
   *  Stamped `harness_delegate_*`, mirroring `harness_agent_id`'s naming so
   *  it can never collide with anything Claude/codex's own payload carries. */
  harness_delegate_parent?: string | null;
  harness_delegate_label?: string | null;
}

/** Normalized event sent to the renderer — one per hook boundary. */
export interface HookEvent {
  agentId: string;
  event: HookEventName | string;
  tool?: string;
  toolTarget?: string;
  notificationType?: string;
  message?: string;
  source?: string;
  /** The claude CLI's own session id (`session_id` on the raw payload), when
   *  present — captured so a SessionStart can stash it on the SessionRecord
   *  for disk-persisted `claude --resume` respawns (Phase 8.5 #1). */
  claudeSessionId?: string;
  /** `tool_use_id` off the raw payload (see `HookPayload.tool_use_id`) — for
   *  a `Task` PreToolUse this is the one identity available at spawn time,
   *  threaded into the `spawn` battle signal (battleBus.ts) so BattleManager
   *  can later correlate this exact dispatch to the CLI-internal task-id a
   *  completion names (see BattleManager.ts's `handleCorrelate`). */
  toolUseId?: string;
  /** Claude Code's CLI-internal subagent identity, copied with its original
   *  top-level field names from a subagent-scoped hook. `agentId` above
   *  remains the harness parent/session id. */
  agent_id?: string;
  agent_type?: string;
  /** Raw `subagent_type` off a `Task` call's `tool_input` (see
   *  `subagentTypeFromInput`) — advisor-pokemon feature. Deliberately
   *  separate from `toolTarget`'s merged description-or-subagent_type label:
   *  a dispatch usually carries a `description` too, which is what
   *  `toolTarget` picks instead, so that field alone can't reliably signal
   *  "this Task call's `subagent_type` is literally `advisor`". hookRouter
   *  .ts's `PreToolUse` `Task` branch reads this to route an advisor consult
   *  to the advisor bus instead of an ordinary battle spawn. */
  subagentType?: string;
}

/** External-codex-delegate feature — a delegate's SessionStart or Stop,
 *  forwarded on its own IPC channel (`hooks:delegate`, never `hooks:event:
 *  <agentId>`) so it can never be mistaken for the attaching parent
 *  session's own hook traffic — see hookBridge.ts's `handleDelegate`. Every
 *  other delegate hook event (PreToolUse, PostToolUse, ...) is dropped at
 *  the bridge and never reaches the renderer at all (item 3's guard against
 *  a subagent/delegate event landing on a channel that isn't theirs). */
export interface DelegateHookSignal {
  /** The harness session id the delegate attaches to
   *  (`POKEHARNESS_DELEGATE_PARENT`). */
  parentId: string;
  event: 'SessionStart' | 'Stop';
  /** Codex's own `session_id` off the raw payload when present, else a
   *  synthesized `delegate:<parentId>:<label>` fallback — `session_id` is
   *  confirmed to be codex's real field name for this (openai/codex @
   *  0.150.1's generated JSON schemas, codex-rs/hooks/schema/generated/
   *  session-start.command.input.schema.json + stop.command.input.schema.
   *  json both require it), so the fallback below is defensive code rather
   *  than a live gap — see hookBridge.ts's `handleDelegate` for the full
   *  citation. Used as the battler's exact identity (spawn's
   *  `toolUseId`, correlate's `taskId`) so SessionStart/Stop always resolve
   *  to the SAME battler, including across a duplicate SessionStart (a
   *  codex retry). */
  codexSessionId: string;
  /** `POKEHARNESS_DELEGATE_LABEL`, or `'codex delegate'` when unset/blank. */
  label: string;
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEventName>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact'
]);

export function isKnownHookEvent(name: string): name is HookEventName {
  return KNOWN_EVENTS.has(name);
}

/** Claude's hook payloads name the Task tool `Agent` (confirmed live against
 *  the real CLI — `tool_name: "Agent"` on every Task-tool PreToolUse/
 *  PostToolUse), while the CLI's own terminal transcript — and this app's
 *  regex-fallback parser, which scrapes that transcript — prints `Task`.
 *  Normalized once here, at the hook-ingestion boundary (HookBridge.handle),
 *  so every downstream consumer (battle spawn/attack gating in hookRouter,
 *  the tool bubble's icon map, move-SFX lookup, garden station routing) only
 *  ever sees `Task`, regardless of which path an event took. */
export function normalizeToolName(name: string | undefined): string | undefined {
  return name === 'Agent' ? 'Task' : name;
}

/** Best-effort human-readable target for a tool call, so the garden's tool
 *  bubble reads the same under hooks as it does under the regex parser (e.g.
 *  "Read App.tsx", "$ npm test"). Every field is optional/untyped upstream —
 *  Claude's tool_input shape varies per tool — so this never throws. */
export function toolTargetFromInput(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  switch (toolName) {
    case 'Bash':
      return pick('command');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'Grep':
    case 'Glob':
      return pick('pattern');
    case 'Task':
      return pick('description', 'subagent_type');
    default:
      return pick('file_path', 'path', 'notebook_path');
  }
}

/** Best-effort raw `subagent_type` off a `Task` call's `tool_input` —
 *  advisor-pokemon feature. Unlike `toolTargetFromInput`'s `Task` case
 *  (which falls back to `subagent_type` only when `description` is absent,
 *  merging both into one display label), this reads `subagent_type` on its
 *  own, unmerged, so hookRouter.ts can test it for the literal value
 *  `'advisor'` regardless of whether a `description` is also present.
 *  Undefined for every non-`Task` tool or an unexpected input shape — never
 *  throws. */
export function subagentTypeFromInput(toolName: string | undefined, input: unknown): string | undefined {
  if (toolName !== 'Task' || !input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>).subagent_type;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
