/**
 * Arceus v2 — poke-ask / poke-spawn / poke-relay request/response shapes,
 * exchanged over the same hooks UDS socket poke-delegate already uses (see
 * main/hookBridge.ts's own header for the socket/env-var auth mechanism).
 * Distinguished from an ordinary HookPayload/DelegateSpawnRequest by `type`,
 * same convention as shared/delegateSpawn.ts.
 *
 * All three are guarded main-side (HookBridge) to callers whose
 * `parentAgentId` is exactly ARCEUS_SESSION_ID — read off the trusted
 * POKEHARNESS_AGENT_ID env var the CLI script inherits, same mechanism (and
 * same trust model) poke-delegate's own `parentAgentId` already relies on:
 * a discoverability boundary against an ordinary session accidentally
 * reaching a tool meant only for Arceus, not real sandboxing against a
 * hostile one (see HookBridge's `isFromArceus` for the fuller caveat).
 *
 * Fire-and-return-immediately by design (plan §3.2 / spike 1): Claude Code's
 * own Bash tool refuses to block synchronously waiting on an external event,
 * so every response here is a fast ack ("accepted"), never the eventual
 * outcome. For `poke-ask`/`poke-spawn`, that outcome arrives later as a
 * fresh pty message into Arceus's OWN session (see each request's own doc
 * comment for exactly how); `poke-relay` never messages Arceus back at
 * all — a failure already shows in the command's own output before his
 * turn ends, and a success just lands, silently, in the target's pty.
 */

export interface PokeToolResponse {
  ok: boolean;
  id?: string;
  note?: string;
  error?: string;
}

/** Shows a picker in the UI; the user's answer is later injected into
 *  ARCEUS'S OWN pty as a fresh message (same window.api.writePty mechanism
 *  ArceusDispatchBox.tsx uses) — never delivered back over this socket. */
export interface PokeAskRequest {
  type: 'poke/ask';
  parentAgentId: string;
  question: string;
  options: string[];
}

/** Spawns a fresh top-level session in the named workspace — same result as
 *  a user manually starting one. `workspace` is matched against the live
 *  workspace registry (id, then name) main-side. The outcome (which
 *  pokémon, which session) is reported back into Arceus's OWN pty once the
 *  renderer has actually created the session, not over this socket. */
export interface PokeSpawnRequest {
  type: 'poke/spawn';
  parentAgentId: string;
  workspace: string;
  task: string;
}

/** Injects `message` into the named agent's pty — `agent` resolves against
 *  the live, non-Arceus roster by id, then session title, then (if
 *  unambiguous) pokémon species, mirroring the deleted `@@relay` directive's
 *  own resolution rule. Delivered via the same idle-safety InjectionQueue
 *  the old ArceusRelayWatcher used (see main/pokeTools.ts's `PokeRelay`) —
 *  queued rather than typed immediately if the target isn't idle, delivered
 *  whenever it next is. */
export interface PokeRelayRequest {
  type: 'poke/relay';
  parentAgentId: string;
  agent: string;
  message: string;
}

/** Pushed main → renderer (`poke:ask`) once `handlePokeAsk` accepts a
 *  request — the renderer shows a picker keyed on `id`; once the user
 *  answers, the RENDERER injects the answer into Arceus's own pty
 *  (window.api.writePty), never back over the socket. */
export interface PokeAskNotice {
  id: string;
  question: string;
  options: string[];
}

/** Pushed main → renderer (`poke:spawned`) right after `ptyManager.spawn()`
 *  succeeds for a validated `poke-spawn` request — mirrors
 *  shared/delegateSpawn.ts's `DelegateSessionSpawned`. The renderer's job:
 *  make it show up as an ordinary session (species pick, store entry,
 *  already-resolved workspace assignment), inject `task` as its first
 *  message, and report back into Arceus's OWN pty once that's done. */
export interface PokeSpawnedNotice {
  id: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  command: string;
  task: string;
}

/** Pushed main → renderer (`poke:relayDelivered`) once a queued/immediate
 *  `poke-relay` message is actually written into its target's pty — the
 *  renderer's only job is to stamp its own `lastDispatch` copy for that
 *  session (main has no renderer store of its own to write to; see
 *  main/pokeTools.ts's `PokeRelay`). */
export interface PokeRelayDeliveredNotice {
  targetId: string;
  message: string;
  at: number;
}
