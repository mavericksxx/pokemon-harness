/** Session lifecycle: spawn a coding-agent CLI, wire its terminal, tear it down. */
import { AGENT_PROVIDERS, buildProviderArgs } from '@shared/agentProvider';
import type { NewSessionRequest, SessionStatus } from '@shared/types';
import type { DelegateSessionSpawned } from '@shared/delegateSpawn';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { resolveEffectiveTheme, terminalSpawnEnv } from '@/design/theme';
import { createTerminal, disposeTerminal, hasTerminal, writeReplayNow } from '@/pty/terminalRegistry';
import { isDemoSession } from '@/demo';
import { pickFreeLine } from '@/scene/garden/showdownArt';
import { baseStageOf, speciesEntry } from '@/scene/garden/dexData';
import { initShinyConfig, rollShiny } from '@/scene/garden/shiny';
import { evolutionConfig } from '@/scene/garden/evolution';

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export async function startSession(req: NewSessionRequest): Promise<void> {
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const preset = AGENT_PROVIDERS[req.provider];
  const command = req.command.trim() || preset.defaultCommand;
  const isPlainTerminal = req.plainTerminal === true;
  let sessionAdded = false;

  try {
    // Create the terminal FIRST: it subscribes to the PTY channels (so no
    // startup output is missed) and it must exist before the session appears in
    // the store, because the drawer attaches as soon as the new session becomes
    // selected.
    createTerminal(id, req.provider);

    // Sessions always hatch at their line's base stage, whatever stage of the
    // line the picker's search resolved to. A shell-only session deliberately
    // skips this entirely: it does not reserve a line, roll shiny state, or
    // create a garden walker.
    let pokemon = '';
    let line = '';
    let shiny = false;
    if (!isPlainTerminal) {
      if (req.pokemon) {
        const base = baseStageOf(req.pokemon);
        pokemon = base.id;
        line = base.line;
      } else {
        const picked = pickFreeLine(useStore.getState().takenLines());
        pokemon = picked.name;
        line = picked.line;
      }
      // The roll happens AFTER species/line resolution, per session, and is
      // awaited so a POKE_SHINY_ODDS override is guaranteed in effect even for
      // the very first session — the config's async IPC read might otherwise
      // still be in flight when the earliest possible session is created (see
      // shiny.ts's header).
      await initShinyConfig();
      shiny = rollShiny();
    }
    useStore.getState().addSession({
      id,
      title: req.title?.trim() || basename(req.cwd),
      cwd: req.cwd,
      command,
      provider: req.provider,
      model: req.model,
      pokemon,
      line,
      shiny,
      isPlainTerminal,
      // Workspaces (Phase 8.7): a new session always joins whichever
      // workspace is active right now — there's no "start in another
      // workspace" picker in the New Session dialog.
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId
    });
    sessionAdded = true;

    // Auto-permission-mode (parity sweep item 1) — appended only when the
    // dialog's per-session override is on AND the provider actually exposes
    // an autonomous mode (agentProvider.ts's `autoModeArgs`); everything else
    // spawns exactly as before this setting existed.
    const autoArgs = req.autoMode ? (preset.autoModeArgs ?? []) : [];
    const res = await window.api.spawnPty({
      id,
      cwd: req.cwd,
      command,
      args: [...buildProviderArgs(req.provider, req.model), ...autoArgs],
      env: terminalSpawnEnv(
        resolveEffectiveTheme(useAppSettingsStore.getState().settings.theme),
        preset.env
      ),
      cols: 100,
      rows: 30,
      provider: req.provider
    });

    if (!res.ok) throw new Error(res.error ?? 'failed to start session.');
    useStore.getState().updateSession(id, { status: 'idle', cwd: res.cwd ?? req.cwd });
    // Recent-folders quick-pick (parity sweep item 6) — recorded only on a
    // CONFIRMED spawn, and `res.cwd` (the tilde-expanded path main actually
    // spawned into), not the raw dialog text, so `~/foo` and its expansion
    // don't accumulate as two separate entries.
    useAppSettingsStore.getState().addRecentFolder(res.cwd ?? req.cwd);
  } catch (err) {
    // A failed spawn must not leave a stale store entry or a ghost tab: undo the
    // terminal and the store entry together rather than surfacing the failure as
    // a permanently-"done" session.
    if (hasTerminal(id)) disposeTerminal(id);
    if (sessionAdded) useStore.getState().removeSession(id);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Start the user's shell in the supplied directory without opening the
 *  new-agent dialog or assigning a Pokemon. */
export async function startPlainTerminal(cwd: string): Promise<void> {
  const trimmedCwd = cwd.trim();
  if (!trimmedCwd) throw new Error('choose a working directory.');
  await startSession({
    provider: 'shell',
    cwd: trimmedCwd,
    command: await window.api.getDefaultShell(),
    plainTerminal: true
  });
}

/**
 * First-class delegate sessions (shared/delegateSpawn.ts) — the app itself
 * already spawned this session's `codex exec` pty (main/index.ts's
 * `onDelegateSpawnRequest`, in response to an orchestrator's `poke-delegate`
 * request) by the time this fires; unlike `startSession` above, there is no
 * `window.api.spawnPty` call here at all — this only makes the already-live
 * pty show up as an ordinary session.
 *
 * Sequencing matters, and in a way `startSession` above never has to worry
 * about: THERE, the pty doesn't exist until after `addSession`, so no exit
 * can race the store entry. HERE, main already spawned the pty before this
 * event even reached the renderer — a codex that exits fast (bad flag, auth
 * failure) can fire `pty:exit` before this function finishes its awaits. So
 * every `await` happens FIRST (species/shiny roll, parent lookup — none of
 * which touch the terminal or the store), then `createTerminal`/`addSession`/
 * `updateSession` run back-to-back with no `await` between them — an exit
 * landing before that synchronous block would find no store entry to update
 * (a real gap, but see below), and one landing during or after it lands on a
 * session that already exists. The replay pull is what's pushed BEHIND that
 * block instead (reversed from `sessions:restore`'s own order, where main
 * captures replay before the renderer does anything at all — safe there only
 * because that pty predates this app process and isn't racing a fresh
 * subscription): `createTerminal` here already subscribed to `pty:data:<id>`
 * before the replay call even goes out, so the only cost of pulling replay
 * last is a few possibly-duplicated bytes, which a terminal tolerates far
 * better than a missed status transition would.
 *
 * Call once, at boot (main.tsx), alongside `startRegistrySync`/
 * `startCompletionToasts`.
 */
export function startDelegateSpawnListener(): void {
  window.api.onDelegateSessionSpawned((spawned: DelegateSessionSpawned) => {
    void adoptDelegateSession(spawned);
  });
}

async function adoptDelegateSession(spawned: DelegateSessionSpawned): Promise<void> {
  if (hasTerminal(spawned.id)) return; // defensive — should never double-fire

  const picked = pickFreeLine(useStore.getState().takenLines());
  // Same shiny-roll sequencing as startSession: awaited so a POKE_SHINY_ODDS
  // override is guaranteed in effect even for the very first delegate.
  await initShinyConfig();
  const shiny = rollShiny();

  // The delegate joins its PARENT's workspace — not "whichever workspace is
  // active right now" (startSession's rule for a user-initiated new session):
  // the orchestrator may be working in a different garden than the one on
  // screen when its request lands. Arceus (global orchestrator, Phase 8.8)
  // has no `workspaceId` of his own (`undefined`, never a concrete default —
  // see shared/types.ts's `isArceus`) — falling back to the active workspace
  // for a delegate spawned under him is correct, not a bug: unlike Arceus
  // himself, a delegate is an ordinary, workspace-scoped session and must
  // resolve to something concrete.
  const parent = useStore.getState().sessions.find((s) => s.id === spawned.parentAgentId);
  const workspaceId = parent?.workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId;

  // Synchronous from here to the end of this block — see the header comment
  // above for why nothing async can sit between `createTerminal` (which
  // wires the `pty:exit` handler that flips status to 'done') and the
  // `addSession` that gives it a store entry to actually update.
  createTerminal(spawned.id, 'codex');
  useStore.getState().addSession({
    id: spawned.id,
    title: spawned.label?.trim() || 'codex delegate',
    cwd: spawned.cwd,
    command: spawned.command,
    provider: 'codex',
    pokemon: picked.name,
    line: picked.line,
    shiny,
    workspaceId,
    delegateParentId: spawned.parentAgentId,
    delegateLabel: spawned.label
  }, { select: false });
  // The pty is already confirmed live (main only sends this event after a
  // successful spawn) — 'idle' immediately, same as startSession does right
  // after its own spawnPty call resolves ok. ptyParser.ts takes it from here.
  useStore.getState().updateSession(spawned.id, { status: 'idle' });

  // The delegate can be a very short-lived command. If it exited before the
  // renderer adopted the pushed spawn event, its normal PtyExit listener had
  // no session record to patch; main retains that delegate-only exit snapshot
  // so this path lands in the same done state instead of resurrecting it idle.
  const earlyExit = await window.api.getPtyExit(spawned.id);
  if (earlyExit) {
    useStore.getState().updateSession(spawned.id, {
      status: 'done',
      exitCode: earlyExit.exitCode,
      tool: undefined,
      toolTarget: undefined,
      station: 'wander'
    });
  }

  const replay = await window.api.getPtyReplay(spawned.id);
  if (replay) writeReplayNow(spawned.id, replay);
}

/**
 * Change which Pokemon represents an already-running session (roster card's
 * "change pokemon" action) — the session keeps its identity (id, terminal,
 * status, everything); `pokemon`/`line`/`workedMs`/`evolutionFrozen` change.
 *
 * Phase C follow-up (change-pokemon stage semantics): the session becomes
 * EXACTLY the species picked — this used to normalize the pick to whatever
 * stage the session's already-accumulated `workedMs` had earned in the new
 * line, which meant a max-evolved session (meganium) could never be wound
 * back to an earlier stage: picking chikorita just gave meganium again.
 * `workedMs` rebases to the PICKED species' own stage threshold (0 for a
 * stage-1 pick, `stage2Ms` for stage 2, `stage3Ms` for stage 3) so the
 * normal evolution cycle restarts cleanly from there instead of the very
 * next 1Hz tick seeing the old accumulated time and immediately re-evolving
 * past the species just picked. Picking the currently-shown species still
 * rebases the clock (acts as "restart the cycle here" — no early-return
 * short-circuit for an unchanged pick).
 *
 * `frozen` persists as `evolutionFrozen` (shared/types.ts) — GardenScene's
 * 1Hz evolution check skips a frozen session's ceremony, same as it already
 * skips a session outside the active workspace; `workedMs` itself keeps
 * accumulating regardless, so unfreezing resumes normally.
 *
 * `shiny` is untouched either way. No ceremony plays for the swap itself
 * (GardenScene's `applyManualSwap` just brings the walker's sprite in line
 * with the new `pokemon` the next time it's safe to).
 */
export function swapSessionPokemon(sessionId: string, pickedId: string, frozen: boolean): void {
  const session = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const base = baseStageOf(pickedId);
  const picked = speciesEntry(pickedId);
  const { stage2Ms, stage3Ms } = evolutionConfig();
  // Rebases to "just arrived at this stage" — 0 for stage 1, otherwise the
  // stage's own earned-threshold, so the per-stage duration a manual pick
  // gets matches organic evolution's (e.g. a stage-2 pick still takes
  // stage3Ms - stage2Ms of NEW work to reach stage 3, not the full
  // stage3Ms). Clamped below stage3Ms regardless: POKE_EVOLVE_SECONDS
  // (evolution.ts) accepts any two positive numbers, and a stage2Ms that
  // happens to be >= stage3Ms under a malformed override must not leave the
  // pick already past the stage-3 threshold it was just set to.
  const workedMs =
    picked?.stage === 3 ? stage3Ms : picked?.stage === 2 ? Math.min(stage2Ms, Math.max(stage3Ms - 1, 0)) : 0;
  useStore.getState().updateSession(sessionId, {
    pokemon: pickedId,
    line: base.line,
    workedMs,
    evolutionFrozen: frozen
  });
  const label = picked?.name ?? pickedId;
  useStore.getState().pushToast(`${session.title} is now ${label}.`);
}

export async function stopSession(id: string): Promise<void> {
  // In-app demo mode (demo.ts) — a demo session has no real pty behind it;
  // killPty would just fail (or worse, hit an unrelated real session if a
  // demo id ever collided with one). Recall/exit still tear down the
  // terminal + store entry exactly as below.
  if (!isDemoSession(id)) await window.api.killPty(id);
  disposeTerminal(id);
  useStore.getState().removeSession(id);
}

/**
 * Mirror the session list AND current selection into main on every change,
 * so a renderer crash's reload (or a plain dev Cmd+R) has something to
 * rebuild from — see main.tsx's boot sequence and main/index.ts's
 * `sessions:restore`. Call once, at boot.
 *
 * Skips the push when neither `sessions` nor `selectedId` changed since the
 * last checkpoint: zustand's `set` only replaces the top-level keys a
 * mutation actually touches, so an unrelated change (toasts...) leaves both
 * in place and would otherwise round-trip them to main for no reason.
 */
/**
 * In-app completion toast (Phase 8 §6): pushes a toast the moment a
 * session's status transitions TO 'done'. Unconditional — unlike the native
 * OS notification for the same event (main/index.ts's `notifyStatusTransitions`,
 * gated on window focus + selection), this one is already inside the app, so
 * there's no "was the user looking at it" gate to apply. Call once, at boot.
 */
export function startCompletionToasts(): void {
  // A single persistent Map, mutated in place (not rebuilt per call): pushToast
  // itself is a store write, so it re-enters this same subscriber synchronously
  // (zustand notifies listeners inline). Updating an entry BEFORE calling
  // pushToast for it means that re-entrant call already sees the transition as
  // consumed — rebuilding the map only after the loop would instead let the
  // nested call see the stale pre-transition value and toast a second time.
  const prevStatus = new Map<string, SessionStatus>();
  useStore.subscribe((state) => {
    for (const session of state.sessions) {
      const was = prevStatus.get(session.id);
      prevStatus.set(session.id, session.status);
      // `was === undefined` covers both a brand-new session AND one first
      // seen already-'done' (e.g. crash-recovery restore) — neither is a
      // fresh completion.
      if (session.status !== 'done' || was === undefined || was === 'done') continue;
      useStore.getState().pushToast(`${session.title} finished.`);
    }
    for (const id of [...prevStatus.keys()]) {
      if (!state.sessions.some((s) => s.id === id)) prevStatus.delete(id);
    }
  });
}

export function startRegistrySync(): void {
  let lastSessions: ReturnType<typeof useStore.getState>['sessions'] | null = null;
  let lastSelectedId: string | null | undefined;
  useStore.subscribe((state) => {
    if (state.sessions === lastSessions && state.selectedId === lastSelectedId) return;
    lastSessions = state.sessions;
    lastSelectedId = state.selectedId;
    // In-app demo mode (demo.ts) — demo sessions are already structurally
    // never on `SessionRecord` beyond the fields every session has, but this
    // is the one place a checkpoint could still round-trip one to disk (a
    // crash/reload's `sessions:restore` would then resurrect a fake session
    // with no terminal/pty behind it). Filtered out here instead, along with
    // a demo selection.
    const persistedSessions = state.sessions.filter((s) => !isDemoSession(s.id));
    const persistedSelectedId = state.selectedId && isDemoSession(state.selectedId) ? null : state.selectedId;
    void window.api.checkpointSessions(persistedSessions, persistedSelectedId);
  });
}
