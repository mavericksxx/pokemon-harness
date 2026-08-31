/**
 * Arceus, the god agent (Phase 8.8) — the summon flow. Mirrors sessions.ts's
 * `startSession`/`stopSession` shape (create the terminal first, add the
 * store entry, spawn, undo both on failure) but under the fixed
 * `ARCEUS_SESSION_ID` (shared/arceus.ts) rather than a fresh id per call —
 * that fixed id is what makes "at most ONE Arceus across ALL workspaces"
 * hold: pty.ts's spawn() already kills any live process under a reused id
 * before starting the new one.
 *
 * NEVER spawns a real claude session for this app's own testing (repo
 * rule). `summonArceus` is the real path (a genuine `claude`, persona typed
 * in as his first prompt once his session is ready — BACKLOG "next up" item
 * 3, replacing the old `--append-system-prompt` flag); `summonArceusDevStandin`
 * swaps that for a plain shell tagged `isArceus`, gated by main's
 * `config:arceusDevStandin` (POKE_ARCEUS_DEV_STANDIN=1) — see the dialog,
 * which picks between them. Everything but the real claude spawn (the
 * cosmos ascent, alpha card, dispatch box, persistence, cross-workspace
 * presence) is exercisable through the stand-in.
 */
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import {
  ARCEUS_DEX_ID,
  ARCEUS_SESSION_ID,
  ARCEUS_TITLE,
  buildArceusArgs,
  buildArceusFirstPrompt,
  type ArceusRosterEntry,
  type ArceusSummonConfig
} from '@shared/arceus';
import { useStore, type Session } from '@/store/store';
import { createTerminal, disposeTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { safeLogDiagnostic } from '@/diagnosticsClient';

export interface SummonArceusRequest {
  cwd: string;
  model?: string;
  autoMode: boolean;
}

function arceusRecord(): Session | undefined {
  return useStore.getState().sessions.find((s) => s.id === ARCEUS_SESSION_ID);
}

/** A live (status !== 'done') Arceus exists — same "live" definition
 *  WorkspaceSwitcher's own live/dead counts use. The summon action selects
 *  him instead of spawning again while this holds. */
export function arceusIsLive(): boolean {
  const s = arceusRecord();
  return !!s && s.status !== 'done';
}

export function selectArceus(): void {
  useStore.getState().select(ARCEUS_SESSION_ID);
}

/** Cancels a pending `armFirstPromptDelivery` (below) — set by that function
 *  while its hook listener/fallback timer are still armed, cleared once it
 *  fires. Called from every place a NEW pty gets spawned under
 *  `ARCEUS_SESSION_ID` (`spawnArceus` here and `tryResumeArceus` further
 *  down) so a prior summon's still-pending delivery can never fire against a
 *  conversation it wasn't meant for — e.g. a fresh summon's Arceus dies
 *  inside the 10s fallback window and the user resumes or re-summons before
 *  it elapses; without this, that stale listener types the persona into
 *  whatever pty now answers to this id, dev-standin shell included. */
let disarmFirstPrompt: (() => void) | null = null;

async function spawnArceus(
  command: string,
  args: string[],
  provider: AgentProviderId,
  req: SummonArceusRequest
): Promise<void> {
  disarmFirstPrompt?.();
  disarmFirstPrompt = null;
  // A previous, now-finished Arceus record (status 'done') is replaced
  // outright — addSession below would otherwise push a SECOND entry under
  // the same id rather than updating the existing one.
  const existing = arceusRecord();
  if (existing) useStore.getState().removeSession(existing.id);
  if (hasTerminal(ARCEUS_SESSION_ID)) disposeTerminal(ARCEUS_SESSION_ID);

  let sessionAdded = false;
  try {
    createTerminal(ARCEUS_SESSION_ID, provider);
    useStore.getState().addSession({
      id: ARCEUS_SESSION_ID,
      title: ARCEUS_TITLE,
      cwd: req.cwd,
      command,
      provider,
      model: req.model,
      pokemon: ARCEUS_DEX_ID,
      line: ARCEUS_DEX_ID,
      shiny: false,
      isArceus: true
      // workspaceId deliberately omitted — Arceus is global (Phase 8.8 §7).
    });
    sessionAdded = true;

    const res = await window.api.spawnPty({
      id: ARCEUS_SESSION_ID,
      cwd: req.cwd,
      command,
      args,
      cols: 100,
      rows: 30,
      provider
    });
    if (!res.ok) throw new Error(res.error ?? 'failed to summon Arceus.');
    useStore.getState().updateSession(ARCEUS_SESSION_ID, { status: 'idle', cwd: res.cwd ?? req.cwd });
  } catch (err) {
    if (hasTerminal(ARCEUS_SESSION_ID)) disposeTerminal(ARCEUS_SESSION_ID);
    if (sessionAdded) useStore.getState().removeSession(ARCEUS_SESSION_ID);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** How long a fresh Arceus summon waits for the SessionStart hook before
 *  delivering the persona anyway (BACKLOG item 3 §1) — hooks going quiet is
 *  a documented possibility elsewhere in this app (hookRouter.ts's own
 *  HOOK_SILENCE_MS fallback), and a session that never gets its persona
 *  would otherwise sit mute forever. Generous backstop, not the expected
 *  path — SessionStart fires within milliseconds of the CLI being up on
 *  every real hook observation this app relies on elsewhere. */
const FIRST_PROMPT_FALLBACK_MS = 10_000;

/** Wraps text in the bracketed-paste escape sequence (`ESC[200~ … ESC[201~`)
 *  so its internal newlines land as literal multi-line content in a CLI's
 *  input box instead of each one submitting a fragment early (the way a bare
 *  `\r` would) — the same mechanism a bracketed-paste-aware terminal app
 *  uses for a pasted multi-line block. The caller still appends a single
 *  trailing `\r` after this to actually press Enter and submit the whole
 *  paste as one turn. Two callers: `armFirstPromptDelivery` below (Arceus's
 *  persona, delivered as his first typed prompt) and BACKLOG phase E's focus
 *  composer (src/renderer/src/pty/focusQueue.ts, for a multiline queued
 *  message). UNVERIFIED against a live CLI (this app must never spawn a real
 *  claude session for its own testing) — if Claude Code's input box doesn't
 *  honor bracketed paste the way assumed here, this is the first place to
 *  look. */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Session list -> roster entries (shared/arceus.ts's `formatRosterBlock`/
 *  `formatRosterLine`) — every session across every workspace, Arceus's own
 *  entry excluded. Exported for ArceusDispatchBox.tsx, which prepends the
 *  same roster (in its compact one-line form) to every message it sends. */
export function toRosterEntries(sessions: Session[]): ArceusRosterEntry[] {
  return sessions
    .filter((s) => !s.isArceus && !s.isPlainTerminal)
    .map((s) => ({ title: s.title, pokemon: s.pokemon, provider: s.provider, status: s.status }));
}

/** Arms delivery of the persona + roster snapshot as Arceus's first typed
 *  prompt. FRESH SUMMONS ONLY — this is called from `summonArceus` alone,
 *  never from `spawnArceus` itself (shared by both real and dev-standin
 *  paths) or from any restore/resume path, which is what keeps a resumed
 *  Arceus from getting his persona typed at him a second time as if it were
 *  a new user message:
 *   - a same-process reload/crash recovery re-adopts an already-running pty
 *     via `createTerminal(id, provider, replay)` (main.tsx's boot()) and
 *     never calls `summonArceus` at all;
 *   - a full app quit + relaunch respawns a disk-persisted Arceus session
 *     via main's `respawnSession`, whose `respawnArgs` (sessionRespawn.ts)
 *     returns `['--resume', claudeSessionId]` for a claude session with a
 *     captured id — never re-passing the persona either, and never routed
 *     through this file at all (that respawn happens main-side, before the
 *     renderer's `restoreSessions` even reattaches the terminal);
 *   - `autoSummonArceus`'s own mid-run re-summon (his process exited but the
 *     app itself is still up) tries `tryResumeArceus` FIRST when the not-live
 *     record it already has still carries a `claudeSessionId`, which also
 *     never calls `summonArceus`.
 *  So `summonArceus` — reached only for a genuinely fresh conversation, from
 *  `SummonArceusDialog`'s first-ever summon, or `autoSummonArceus`'s fallback
 *  when there's nothing resumable (no saved id, or a dead `--resume`) — is
 *  the one path that should ever get this. */
function armFirstPromptDelivery(personaText: string, rosterFilePath: string): void {
  // Belt-and-suspenders: every spawn point already disarms a pending
  // delivery itself (see `disarmFirstPrompt`'s own comment) before this is
  // ever called, but a stale arm left over from a caller that doesn't is
  // still cancelled rather than left to fire later.
  disarmFirstPrompt?.();

  let delivered = false;
  let offHook: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (delivered) return;
    delivered = true;
    offHook?.();
    if (timer !== null) clearTimeout(timer);
  };

  const deliver = (): void => {
    if (delivered) return;
    disarm();
    if (disarmFirstPrompt === disarm) disarmFirstPrompt = null;
    const roster = toRosterEntries(useStore.getState().sessions);
    const prompt = buildArceusFirstPrompt(personaText, roster, rosterFilePath);
    void window.api.writePty(ARCEUS_SESSION_ID, wrapBracketedPaste(prompt) + '\r');
  };

  offHook = window.api.onHookEvent(ARCEUS_SESSION_ID, (evt) => {
    if (evt.event === 'SessionStart') deliver();
  });
  timer = setTimeout(deliver, FIRST_PROMPT_FALLBACK_MS);
  disarmFirstPrompt = disarm;
}

/** Serializes every fresh-summon call (`summonArceus` and its dev-standin
 *  sibling below) against one another. Without this, two overlapping callers
 *  — e.g. `main.tsx`'s boot-time `autoSummonArceus()` (fired but not
 *  awaited, so the topbar chip and roster card are already clickable while
 *  it's still in flight) racing a user's own click, or the chip and roster
 *  card clicked in quick succession — can both pass the "arceus isn't live
 *  yet" check before either one's `addSession` lands, then both call
 *  `spawnArceus`: the second one's `existing` cleanup tears down the first's
 *  terminal/session and spawns its own pty under the same `ARCEUS_SESSION_ID`
 *  out from under the first call's still-armed `armFirstPromptDelivery`
 *  listener (that listener isn't cleaned up until ITS OWN `deliver()` fires).
 *  Both listeners then race to type the persona into the one surviving pty —
 *  the persona gets typed twice into a single fresh conversation. Queuing
 *  overlapping callers onto the SAME in-flight promise instead of letting
 *  each start its own summon closes that gap at its one shared choke point. */
let summonInFlight: Promise<void> | null = null;

function guardedSummon(run: () => Promise<void>): Promise<void> {
  if (summonInFlight) return summonInFlight;
  const p = run().finally(() => {
    if (summonInFlight === p) summonInFlight = null;
  });
  summonInFlight = p;
  return p;
}

/** Real summon — a genuine `claude` session, spawned PLAIN (no
 *  `--append-system-prompt`); agents/arceus/SYSTEM.md's CURRENT contents
 *  (re-read fresh here every call; see main/arceusPrompt.ts) are instead
 *  typed in as his first prompt once his session reports ready — see
 *  `armFirstPromptDelivery` above. */
export async function summonArceus(req: SummonArceusRequest): Promise<void> {
  return guardedSummon(async () => {
    const { path, prompt, rosterPath } = await window.api.ensureArceusSystemPrompt();
    if (!prompt.trim()) {
      throw new Error(`${path} is empty — write Arceus's instructions there and summon again.`);
    }
    const args = buildArceusArgs(req.model, req.autoMode);
    await spawnArceus(AGENT_PROVIDERS.claude.defaultCommand, args, 'claude', req);
    armFirstPromptDelivery(prompt, rosterPath);
  });
}

/** Dev-only stand-in — see this file's header. Gated at the call site
 *  (SummonArceusDialog) on `config:arceusDevStandin`, not here. */
export async function summonArceusDevStandin(req: SummonArceusRequest): Promise<void> {
  return guardedSummon(async () => {
    const shell = await window.api.getDefaultShell();
    await spawnArceus(shell, [], 'shell', req);
  });
}

// ─── Summon-once (Phase 8.9) ────────────────────────────────────────────────
// "arceus should only have to be onboarded the first time" — the ORIGINAL
// summon (below, from SummonArceusDialog) stays explicit/user-initiated and
// is the only thing that WRITES agents/arceus/summon.json. Every later
// launch (main.tsx boot(), and the topbar chip if he's ever not live) reads
// it back and re-summons him silently. Note (BACKLOG item 3): this silent
// re-summon is only free when it resumes an existing conversation — a
// disk-persisted session at app boot (sessionRespawn.ts's `--resume`,
// main-side, never routed through `summonArceus`) or a mid-run one
// (`autoSummonArceus`'s own `tryResumeArceus`, above `autoSummonArceus`
// below) — a genuinely FRESH re-summon (nothing resumable, or a dead
// `--resume`) now sends the persona as a real first prompt
// (`armFirstPromptDelivery` above) and so does cost a turn, same as any
// other fresh Arceus conversation.
export function loadArceusSummonConfig(): Promise<ArceusSummonConfig | null> {
  return window.api.getArceusSummonConfig();
}

/** Called once, right after a successful FIRST summon — see
 *  SummonArceusDialog's submit handler, the only caller. */
export function saveArceusSummonConfig(config: ArceusSummonConfig): Promise<void> {
  return window.api.saveArceusSummonConfig(config);
}

/** Settings' "reset arceus" action — returns the app to first-run behavior
 *  (does not touch a currently-live Arceus session, if any; only clears the
 *  saved config so the NEXT time he isn't live, the setup dialog shows
 *  again instead of a silent auto-summon). */
export function resetArceusSummonConfig(): Promise<void> {
  return window.api.resetArceusSummonConfig();
}

export type AutoSummonOutcome = 'summoned' | 'no-config' | 'failed';

/** Grace period a mid-run `--resume` gets before this app trusts it really
 *  landed — mirrors main's own `sessionRespawn.ts` `RESUME_GRACE_MS`, used
 *  there for the identical reason (an invalid/expired session id makes the
 *  CLI print an error and exit almost immediately, which a bare successful
 *  spawn can't detect). Duplicated as a plain constant rather than shared:
 *  `sessionRespawn.ts` is main-only. */
const RESUME_GRACE_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Continues an existing, not-currently-live Arceus conversation via
 *  `claude --resume <id>` under the same fixed `ARCEUS_SESSION_ID`, instead
 *  of starting a brand-new one — the ONLY thing that keeps a mid-run
 *  re-summon (his process exited but the app itself never restarted, so
 *  main's own boot-time `--resume` in sessionRespawn.ts never got a chance
 *  to run) from silently abandoning a resumable conversation for a fresh one
 *  with the persona typed in again. `autoSummonArceus` below is the only
 *  caller, and only tries this when the not-live record it already has still
 *  carries a `claudeSessionId` (set once by hookRouter.ts's SessionStart
 *  case and never cleared).
 *
 *  Deliberately does NOT go through `spawnArceus`: that helper always tears
 *  down and rebuilds the terminal (right for a genuinely fresh conversation,
 *  wrong here) — a session that merely went 'done' mid-run keeps its
 *  terminal (terminalRegistry.ts's exit handler only ever updates `status`),
 *  so `createTerminal`'s own `entries.has` guard makes the call below a
 *  no-op unless something already disposed it. Never arms
 *  `armFirstPromptDelivery` — the persona is already in this conversation's
 *  history.
 *
 *  Returns whether the resume is still alive after the grace period; `false`
 *  (spawn failure, or a dead resume caught by the grace period) tells
 *  `autoSummonArceus` to fall through to a genuine fresh summon instead —
 *  same "dead resume ⇒ fresh summon with persona IS correct" rule the
 *  boot-time path already follows. */
async function tryResumeArceus(cwd: string, claudeSessionId: string): Promise<boolean> {
  // Cancels any first-prompt delivery still armed from an earlier fresh
  // summon whose process died before its own arm fired/expired — otherwise
  // that listener would fire against THIS resumed conversation once the new
  // pty's SessionStart arrives, typing the persona into a chat that already
  // has it (see `disarmFirstPrompt`'s own comment).
  disarmFirstPrompt?.();
  disarmFirstPrompt = null;
  createTerminal(ARCEUS_SESSION_ID, 'claude');
  const res = await window.api.spawnPty({
    id: ARCEUS_SESSION_ID,
    cwd,
    command: AGENT_PROVIDERS.claude.defaultCommand,
    args: ['--resume', claudeSessionId],
    cols: 100,
    rows: 30,
    provider: 'claude'
  });
  if (!res.ok) return false;
  // `exitCode` is cleared too — it's the PREVIOUS (dead) process's, and would
  // otherwise read as stale info about a session that hasn't exited this time.
  useStore.getState().updateSession(ARCEUS_SESSION_ID, { status: 'idle', cwd: res.cwd ?? cwd, exitCode: undefined });
  await sleep(RESUME_GRACE_MS);
  return arceusRecord()?.status !== 'done';
}

/** Summons Arceus from the saved config, picking real vs. dev-standin the
 *  same way SummonArceusDialog does. Used both at launch (main.tsx boot(),
 *  when he isn't among the restored sessions) and from the topbar chip
 *  (SummonArceusButton, when he's saved-but-not-live). Never throws —
 *  `'failed'` covers claude missing from PATH, a dead `--resume` AND a
 *  failed fresh spawn, or any other spawn error; the caller turns that into
 *  a quiet toast, never a dialog.
 *
 *  Tries a mid-run `--resume` (`tryResumeArceus` above) before ever falling
 *  back to a fresh summon — the not-live record already in the store (if
 *  any) is the one source of truth for whether a resumable conversation
 *  exists, same signal main's own boot-time restore keys off, so the
 *  decision never depends on which caller (chip, roster card, or boot)
 *  reached here. */
export async function autoSummonArceus(): Promise<AutoSummonOutcome> {
  const config = await loadArceusSummonConfig();
  if (!config) return 'no-config';
  try {
    const devStandin = await window.api.getArceusDevStandin();
    if (devStandin) {
      await summonArceusDevStandin(config);
      return 'summoned';
    }
    // Same `provider === 'claude'` guard sessionRespawn.ts's `shouldResume`
    // uses — a dev-standin record is a plain shell and would never carry a
    // `claudeSessionId` anyway, but this keeps the check exact rather than
    // relying on that being incidentally true.
    const existing = arceusRecord();
    if (
      existing?.provider === 'claude' &&
      existing.claudeSessionId &&
      (await tryResumeArceus(existing.cwd, existing.claudeSessionId))
    ) {
      return 'summoned';
    }
    await summonArceus(config);
    return 'summoned';
  } catch (err) {
    console.error('[arceus] auto-summon failed:', err);
    // Already toasted to the user (main.tsx's boot()) but that's UI-only —
    // this is what makes "arceus won't come back" traceable in harness.log
    // (BACKLOG friend-testing readiness).
    safeLogDiagnostic('arceus', 'error', 'auto-summon failed', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return 'failed';
  }
}

// ─── Relay toast (BACKLOG "next up" item 3 §3, §6) ──────────────────────────
// The relay directive itself is watched and resolved main-side
// (main/arceusRelay.ts, tailing Arceus's own transcript) — main already owns
// the pty writes and the session-list mirror it needs to resolve a name.
// The one thing only the renderer can do is the toast, so main sends just
// the failure case over `arceus:relayUnresolved` and this turns it into one.

/** Subscribes once to unresolved-relay-target notices and turns each into a
 *  toast. Call once, from main.tsx's boot(), same as sessions.ts's
 *  `startRegistrySync`/`startCompletionToasts`. */
export function startArceusRelayToasts(): void {
  window.api.onArceusRelayUnresolved((name) => {
    useStore.getState().pushToast(`arceus tried to reach '${name}' — no such agent`);
  });
}
