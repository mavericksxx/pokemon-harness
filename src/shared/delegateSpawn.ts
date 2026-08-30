/**
 * First-class delegate sessions — the orchestrator (a Claude CLI running
 * inside a harness pty) asks the running app to spawn a real `codex exec`
 * pty session on its behalf, instead of launching one as a plain background
 * subprocess the app can't see (see main/hookBridge.ts's `DELEGATE_PARENT_ENV`
 * doc comment for that older, still-supported roaming-battler-only path).
 *
 * The request travels over the SAME Unix domain socket the hook shims already
 * dial (main/hookBridge.ts's `HOOK_SOCK_ENV`) — see that file's header for why
 * that socket, discovered via env vars this app's own pty already set on the
 * orchestrator's process, IS the auth boundary here (no separate bearer
 * token): only a descendant of an app-spawned `claude` pty ever has
 * `POKE_HOOK_SOCK`/`POKEHARNESS_AGENT_ID` in its env, and the socket itself
 * lives under this app's own userData directory. Distinguished from an
 * ordinary `HookPayload` (shared/hookEvents.ts) by the `type` field, which no
 * real Claude/codex hook payload ever carries.
 */

/** Sent by `poke-delegate.cjs` (the CLI client installed alongside the hook
 *  shims — see hookBridge.ts's `ensureFiles`) over the hooks UDS. */
export interface DelegateSpawnRequest {
  type: 'delegate/spawn';
  /** The orchestrator's own harness session id — read off its `POKEHARNESS_
   *  AGENT_ID` env var by the CLI client, never passed as a flag: an
   *  orchestrator can only name ITSELF as the parent, not some other
   *  session. Validated against the live pty registry before anything spawns
   *  (main/index.ts's `onDelegateSpawnRequest`). */
  parentAgentId: string;
  /** Card title (falls back to 'codex delegate', same default the older
   *  roaming-battler path uses — see hookBridge.ts's `handleDelegate`). */
  label?: string;
  /** Working directory for the `codex exec` invocation — must already exist
   *  and be a directory; validated main-side before spawning anything. */
  cwd: string;
  /** The task text, passed as `codex exec`'s trailing prompt argument. */
  prompt: string;
  /** `-c model_reasoning_effort=<value>` — defaults to 'medium' when absent. */
  reasoningEffort?: string;
}

/** Reply written back over the same socket connection. `id` is the new
 *  session's id (same id space as a renderer-created session, `s-<ts>-
 *  <rand>`) — what `poke-delegate.cjs` prints to stdout on success. */
export interface DelegateSpawnResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Pushed main → renderer (`delegate:sessionSpawned`) right after
 *  `ptyManager.spawn()` succeeds for a validated request — the pty is
 *  already live and producing output by the time the renderer sees this. The
 *  renderer's only job is to make it show up as an ordinary session: create
 *  its terminal (pulling replay itself, since the pty may already have
 *  emitted bytes before this event's IPC round-trip lands — see
 *  sessions.ts's `startDelegateSpawnListener`) and add a roster entry. */
export interface DelegateSessionSpawned {
  id: string;
  parentAgentId: string;
  label?: string;
  cwd: string;
  command: string;
  args: string[];
}
