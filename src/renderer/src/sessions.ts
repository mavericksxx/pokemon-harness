/** Session lifecycle: spawn a coding-agent CLI, wire its terminal, tear it down. */
import { AGENT_PROVIDERS, buildProviderArgs } from '@shared/agentProvider';
import type { NewSessionRequest, SessionStatus } from '@shared/types';
import type { DelegateSessionSpawned } from '@shared/delegateSpawn';
import type { PokeRelayDeliveredNotice, PokeSpawnedNotice } from '@shared/pokeTools';
import { wrapBracketedPaste } from '@/arceus';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { createTerminal, disposeTerminal, hasTerminal, recreateTerminal, writeReplayNow } from '@/pty/terminalRegistry';
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
  const previousSelectedId = useStore.getState().selectedId;

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
        // An alt-battle-form pick (e.g. Zacian-Crowned) isn't a chain stage
        // at all — normalizing it to its base stage the way a mid-chain pick
        // (e.g. Charmeleon -> Charmander) gets normalized would silently
        // swap out the form the user actually chose. Exact-species for a
        // form, same "not earned-stage-normalized" precedent as
        // `swapSessionPokemon` below.
        const picked = speciesEntry(req.pokemon);
        const base = baseStageOf(req.pokemon);
        pokemon = picked?.baseSpecies ? req.pokemon : base.id;
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
      env: preset.env,
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
    if (sessionAdded) {
      useStore.getState().removeSession(id);
      if (previousSelectedId && useStore.getState().sessions.some((session) => session.id === previousSelectedId)) {
        useStore.getState().select(previousSelectedId);
      }
    }
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
  if (earlyExit && useStore.getState().sessions.find((s) => s.id === spawned.id)?.status !== 'done') {
    useStore.getState().updateSession(spawned.id, {
      status: 'done',
      exitCode: earlyExit.exitCode,
      tool: undefined,
      toolTarget: undefined,
      station: 'wander'
    });
    // status is now 'done' — writeReplayNow's own guard skips feeding this
    // through the tool-call parser, matching a normal exit's behavior.
    if (earlyExit.lastOutput) writeReplayNow(spawned.id, earlyExit.lastOutput);
    writeReplayNow(spawned.id, `\r\n\x1b[90m[process exited with code ${earlyExit.exitCode}]\x1b[0m\r\n`);
  }

  const replay = await window.api.getPtyReplay(spawned.id);
  if (replay) writeReplayNow(spawned.id, replay);
}

/**
 * Arceus v2 (docs/arceus-v2-plan.md §3.2/§7) — `poke-spawn`'s renderer half.
 * Main already spawned the real pty (main/index.ts's `onPokeSpawn`) by the
 * time this fires; mirrors `adoptDelegateSession` above almost exactly
 * (species pick, store entry, no `window.api.spawnPty` call here) with two
 * differences: the workspace is ALREADY resolved (`spawned.workspaceId`,
 * not "whichever workspace is active" or "the parent's workspace"), and the
 * initial task is injected as this session's first typed message — the
 * bracketed-paste + `\r` mechanism Arceus's own persona used to get his
 * first prompt this same way — and stamped as its `lastDispatch`, the
 * continuity signal `writeArceusRosterFile` (main-side) reads for a future
 * "was this agent already working on something" decision.
 */
export function startPokeSpawnListener(): void {
  window.api.onPokeSpawn((spawned: PokeSpawnedNotice) => {
    void adoptPokeSpawn(spawned);
  });
}

async function adoptPokeSpawn(spawned: PokeSpawnedNotice): Promise<void> {
  if (hasTerminal(spawned.id)) return; // defensive — should never double-fire

  const picked = pickFreeLine(useStore.getState().takenLines());
  // Same shiny-roll sequencing as startSession/adoptDelegateSession.
  await initShinyConfig();
  const shiny = rollShiny();

  const title = spawned.task.length > 60 ? `${spawned.task.slice(0, 57)}...` : spawned.task;

  createTerminal(spawned.id, 'claude');
  useStore.getState().addSession(
    {
      id: spawned.id,
      title,
      cwd: spawned.cwd,
      command: spawned.command,
      provider: 'claude',
      pokemon: picked.name,
      line: picked.line,
      shiny,
      workspaceId: spawned.workspaceId
    },
    { select: false }
  );
  useStore.getState().updateSession(spawned.id, { status: 'idle' });

  void window.api.writePty(spawned.id, wrapBracketedPaste(spawned.task) + '\r');
  useStore.getState().updateSession(spawned.id, { lastDispatch: { at: Date.now(), message: spawned.task } });
  // A `poke-spawn` is an autonomous action the user may not be watching for
  // — a plain confirmation toast, same spirit as `swapSessionPokemon`'s own,
  // is the one place `spawned.workspaceName` earns its spot on the wire.
  useStore.getState().pushToast(`arceus spawned ${picked.name} in ${spawned.workspaceName}.`);
}

/** Arceus v2 — `poke-relay`'s renderer half. Main already resolved the
 *  target and typed the message into its pty (main/pokeTools.ts's
 *  `PokeRelay`, idle-safety queue included) by the time this fires; the
 *  renderer's only remaining job is stamping its own `lastDispatch` copy for
 *  that session (main has no store of its own to write to). */
export function startPokeRelayDeliveredListener(): void {
  window.api.onPokeRelayDelivered(({ targetId, message, at }: PokeRelayDeliveredNotice) => {
    useStore.getState().updateSession(targetId, { lastDispatch: { at, message } });
  });
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
  await window.api.killPty(id);
  disposeTerminal(id);
  useStore.getState().removeSession(id);
}

/**
 * Recovery action for the red "could not be resumed" banner FocusView.tsx
 * shows on a session whose `error` field main's `restoreFromDisk`
 * (sessionRespawn.ts) set at app launch — the original `claude --resume`
 * failed (an expired/invalid session id, or the CLI's own transcript left in
 * a state it can't resume after an abrupt quit) and the app already fell
 * back to a plain shell under the same card so nothing is lost. That shell
 * works, but the banner never clears on its own and there's no way to get a
 * real agent running again short of typing the CLI by hand.
 *
 * This re-spawns a BRAND NEW (never `--resume`) process under the session's
 * original command/provider/model, on the exact same id — `PtyManager.spawn`
 * (main/pty.ts) already kills whatever is currently living under a reused id
 * first, so the fallback shell is torn down as a side effect. `claudeSessionId`
 * needs no explicit clearing: the fresh process's own SessionStart hook
 * (hookRouter.ts) overwrites it with the new conversation's id the moment it
 * fires.
 */
export async function restartSessionFresh(id: string): Promise<void> {
  const session = useStore.getState().sessions.find((s) => s.id === id);
  if (!session) return;
  // A session showing this banner got here via a shell-fallback exit under
  // its id, which permanently nulls this id's terminal entry's regex-fallback
  // `parser` (terminalRegistry.ts's `createTerminal` — see the `fallback`
  // branch of its `onPtyExit` handler). Respawning straight into that entry
  // (as this used to) would leave the fresh process running with a dead
  // parser, so its status can freeze the moment hooks go quiet
  // (hookRouter.ts's HOOK_SILENCE_MS) with no regex fallback left to catch
  // it. `recreateTerminal` mirrors arceus.ts's `tryResumeArceus` (its own
  // mid-run resume hits the identical hazard) — dispose + recreate the entry,
  // re-attaching it if this session's terminal is the one currently open in
  // the drawer — and runs BEFORE the respawn below so the fresh pty's
  // earliest output is never missed, same ordering `startSession` uses.
  recreateTerminal(id, session.provider);
  const res = await window.api.spawnPty({
    id,
    cwd: session.cwd,
    command: session.command,
    args: buildProviderArgs(session.provider, session.model),
    provider: session.provider,
    cols: 100,
    rows: 30
  });
  if (!res.ok) {
    useStore.getState().updateSession(id, { error: res.error ?? 'could not start a fresh session.' });
    return;
  }
  useStore.getState().updateSession(id, {
    error: undefined,
    status: 'idle',
    tool: undefined,
    toolTarget: undefined,
    station: 'wander',
    looping: false,
    cwd: res.cwd ?? session.cwd,
    // Bug fix: a fresh (non-`--resume`) process starts a brand-new
    // conversation with no cost/model history of its own yet — without
    // this, the old process's last-known cost/context% and any
    // "↺ changed from" model badge keep showing until the new process's
    // CostWatcher parses its own first transcript update. `undefined`
    // matches what a brand-new session has at creation (store.ts's
    // `addSession` — both fields are simply absent until set).
    cost: undefined,
    modelChangedFrom: undefined
  });
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
 *
 * Also logs a `'blocked'` transition to the notification bell's history
 * (`pushNotification`, not `pushToast`) — no new visible toast, the existing
 * `blocked` UI (native OS notification included) is untouched, this just
 * makes the transition visible in the bell too.
 */
export function startCompletionToasts(): void {
  // A single persistent Map, mutated in place (not rebuilt per call): pushToast
  // itself is a store write, so it re-enters this same subscriber synchronously
  // (zustand notifies listeners inline). Updating an entry BEFORE calling
  // pushToast for it means that re-entrant call already sees the transition as
  // consumed — rebuilding the map only after the loop would instead let the
  // nested call see the stale pre-transition value and toast a second time.
  const prevStatus = new Map<string, SessionStatus>();
  // Same reference-equality short-circuit `startRegistrySync` below already
  // uses: this subscribes without a selector, so it re-runs on EVERY store
  // mutation, not just a session-list change — zustand's `set` only replaces
  // the top-level keys a mutation actually touches, so an unrelated change
  // (toasts, a garden-only field, ...) leaves `state.sessions` as the exact
  // same array reference and this loop has nothing new to find.
  let lastSessions: ReturnType<typeof useStore.getState>['sessions'] | null = null;
  useStore.subscribe((state) => {
    if (state.sessions === lastSessions) return;
    lastSessions = state.sessions;
    for (const session of state.sessions) {
      const was = prevStatus.get(session.id);
      prevStatus.set(session.id, session.status);
      // `was === undefined` covers both a brand-new session AND one first
      // seen already in that status (e.g. crash-recovery restore) — neither
      // is a fresh transition.
      if (was === undefined) continue;
      if (session.status === 'done' && was !== 'done') {
        const msg = typeof session.exitCode === 'number' && session.exitCode !== 0
          ? `${session.title} exited with code ${session.exitCode}.`
          : `${session.title} finished.`;
        useStore.getState().pushToast(msg);
      } else if (session.status === 'blocked' && was !== 'blocked') {
        useStore.getState().pushNotification(`${session.title} needs your input.`);
      }
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
    void window.api.checkpointSessions(state.sessions, state.selectedId);
  });
}
