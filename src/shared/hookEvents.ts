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
