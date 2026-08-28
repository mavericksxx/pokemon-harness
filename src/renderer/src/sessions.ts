/** Session lifecycle: spawn a coding-agent CLI, wire its terminal, tear it down. */
import { AGENT_PROVIDERS, buildProviderArgs } from '@shared/agentProvider';
import type { NewSessionRequest, SessionStatus } from '@shared/types';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { createTerminal, disposeTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { pickFreeLine } from '@/scene/garden/showdownArt';
import { baseStageOf, speciesEntry, stageForWorkedMs } from '@/scene/garden/dexData';
import { initShinyConfig, rollShiny } from '@/scene/garden/shiny';

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export async function startSession(req: NewSessionRequest): Promise<void> {
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const preset = AGENT_PROVIDERS[req.provider];
  const command = req.command.trim() || preset.defaultCommand;
  let sessionAdded = false;

  try {
    // Create the terminal FIRST: it subscribes to the PTY channels (so no
    // startup output is missed) and it must exist before the session appears in
    // the store, because the drawer attaches as soon as the new session becomes
    // selected.
    createTerminal(id, req.provider);

    // Sessions always hatch at their line's base stage, whatever stage of the
    // line the picker's search resolved to.
    let pokemon: string;
    let line: string;
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
    const shiny = rollShiny();
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
    if (sessionAdded) useStore.getState().removeSession(id);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Change which Pokemon represents an already-running session (roster card's
 * "change pokemon" action) — the session keeps its identity (id, terminal,
 * status, everything); only `pokemon`/`line` change. Unlike `startSession`,
 * which always normalizes a pick down to its line's base stage (workedMs is
 * always 0 for a brand-new session), this normalizes to whatever stage the
 * session's ALREADY-accumulated workedMs has earned in the new line — see
 * `stageForWorkedMs`. No ceremony plays for the swap itself (GardenScene's
 * `applyManualSwap` just brings the walker's sprite in line with the new
 * `pokemon` the next time it's safe to).
 */
export function swapSessionPokemon(sessionId: string, pickedId: string): void {
  const session = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const base = baseStageOf(pickedId);
  const nextId = stageForWorkedMs(pickedId, session.workedMs);
  if (nextId === session.pokemon) return; // already this species at this stage — nothing to swap
  useStore.getState().updateSession(sessionId, { pokemon: nextId, line: base.line });
  const label = speciesEntry(nextId)?.name ?? nextId;
  useStore.getState().pushToast(`${session.title} is now ${label}.`);
}

export async function stopSession(id: string): Promise<void> {
  await window.api.killPty(id);
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
    void window.api.checkpointSessions(state.sessions, state.selectedId);
  });
}
