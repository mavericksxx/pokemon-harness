import { handle } from './handle';
import { writeArceusRosterFile } from '../arceusRosterFile';
import type { PtyManager } from '../pty';
import type { SessionPersistence } from '../sessionPersistence';
import type { PokeRelay } from '../pokeTools';
import type { CostWatcher } from '../costWatcher';
import type { TaskNotificationWatcher } from '../taskNotificationWatcher';
import type { DiskRestoreInfo, RestartStaleResult, SessionRecord } from '../../shared/types';
import type { WorkspaceSnapshot } from '../../shared/workspaceTypes';
import type { AgentProviderId } from '../../shared/agentProvider';
import { respawnSession, shouldResume } from '../sessionRespawn';

export interface SessionsIpcDeps {
  ptyManager: PtyManager;
  sessionPersistence: SessionPersistence;
  pokeRelay: PokeRelay;
  costWatcher: CostWatcher;
  taskNotificationWatcher: TaskNotificationWatcher;
  notifyStatusTransitions: (sessions: SessionRecord[], selectedId: string | null) => void;
  getSessionRegistry: () => SessionRecord[];
  setSessionRegistry: (sessions: SessionRecord[]) => void;
  getLastSelectedId: () => string | null;
  setLastSelectedId: (id: string | null) => void;
  getHarnessHomeDir: () => string;
  getDefaultAgentProvider: () => Promise<AgentProviderId>;
  getWorkspaceRegistry: () => WorkspaceSnapshot;
  getDiskRestorePromise: () => Promise<DiskRestoreInfo>;
  isDiskRestoreConsumed: () => boolean;
  setDiskRestoreConsumed: (consumed: boolean) => void;
}

export function registerSessionsIpc(deps: SessionsIpcDeps): void {
  const {
    ptyManager,
    sessionPersistence,
    pokeRelay,
    costWatcher,
    taskNotificationWatcher,
    notifyStatusTransitions,
    getSessionRegistry,
    setSessionRegistry,
    getLastSelectedId,
    setLastSelectedId,
    getHarnessHomeDir,
    getDefaultAgentProvider,
    getWorkspaceRegistry,
    getDiskRestorePromise,
    isDiskRestoreConsumed,
    setDiskRestoreConsumed
  } = deps;

  // Renderer → main mirror, called on every session-list or selection change
  // (see `startRegistrySync` in src/renderer/src/sessions.ts) — see
  // sessionRegistry's own comment above for why this replaces wholesale rather
  // than upserting.
  handle('sessions:checkpoint', (_e, sessions: SessionRecord[], selectedId: string | null) => {
    notifyStatusTransitions(sessions, selectedId);
    setSessionRegistry(sessions);
    setLastSelectedId(selectedId);
    // First-class delegate sessions (shared/delegateSpawn.ts) are excluded from
    // DISK persistence only (sessionRegistry above still mirrors them, for
    // notifications/roster file below) — SessionRecord has no field for the
    // prompt that launched one, so a relaunch's `respawnSession`
    // (sessionRespawn.ts) would otherwise respawn a bare, promptless
    // interactive `codex` under a delegate's old card. Silently re-running the
    // ORIGINAL task (if the prompt were persisted instead) would be worse: a
    // delegate still live when the app quits is simply not resurrected, same
    // as a session closed in-app via stopSession never reaching this file.
    // This is also why pty.ts's `detachAllToKeepers` (the "leave running"
    // quit path) kills a delegate outright instead of detaching it to a
    // keeper — a keeper nothing here ever persists would just run orphaned,
    // never found by a later `tryReattach`.
    sessionPersistence.schedule({
      sessions: sessions.filter((s) => !s.delegateParentId),
      lastSelectedId: selectedId
    });
    // Arceus v2 (docs/arceus-v2-plan.md §3.2) — flushes any `poke-relay`
    // queued for a target that's now idle (or drops it if that target
    // closed/finished in the meantime). Cheap no-op when nothing is queued.
    pokeRelay.onSessionsChecked(sessions);
    // Cadence gating (2026-09-01) — this checkpoint fires synchronously off
    // every renderer session-status change (see startRegistrySync in
    // sessions.ts), so it's also the resume/pause trigger for costWatcher's
    // and taskNotificationWatcher's own POLL_MS timers: each only needs to run
    // while a session it tracks is actually producing new transcript content.
    // See each watcher's own file header for the exact gate.
    costWatcher.onSessionsChecked(sessions);
    taskNotificationWatcher.onSessionsChecked(sessions);
    // Regenerates agents/arceus/roster.json (self-serve roster Arceus can read
    // with his own tools) — cheap no-op when nothing roster-relevant changed.
    writeArceusRosterFile(getHarnessHomeDir(), sessions, getWorkspaceRegistry().workspaces);
  });

  // Boot-time pull, for both a crash-triggered reload and a plain dev Cmd+R:
  // only sessions whose PTY is still actually alive come back — a session
  // whose process had already exited before the reload has nothing live to
  // reattach to, so its tab just doesn't reappear (its checkpoint may still be
  // sitting in sessionRegistry from before the exit; ptyManager.list() is the
  // authority here, not the mirror). Same liveness check for selectedId: no
  // point reselecting a tab that isn't coming back.
  handle('sessions:restore', async () => {
    // Awaits the launch-time disk restore (a no-op once it's already settled,
    // which is the common case by the time the renderer gets this far) so this
    // never races ahead of `restoreFromDisk` and sees a still-empty registry —
    // see that function's own header.
    await getDiskRestorePromise();
    const liveIds = new Set(ptyManager.list().map((p) => p.id));
    const sessions = getSessionRegistry()
      .filter((s) => liveIds.has(s.id))
      .map((session) => ({
        session,
        replay: ptyManager.getReplay(session.id),
        // Read AFTER getReplay (harmless either order — reattach status
        // doesn't change from reading replay) so `reattached` reflects the
        // session that's actually live right now, same source `replay`
        // itself came from. See RestoredSession's own comment for why the
        // renderer needs this.
        reattached: ptyManager.isReattachedSession(session.id)
      }));
    const lastSelectedId = getLastSelectedId();
    const selectedId = lastSelectedId && liveIds.has(lastSelectedId) ? lastSelectedId : null;
    return { sessions, selectedId };
  });

  // Boot-time pull for the "restored N sessions" toast (Phase 8.5 #1) — see
  // `diskRestoreConsumed`'s own comment for why this is clear-on-read.
  handle('app:getDiskRestoreInfo', async () => {
    const info = await getDiskRestorePromise();
    if (isDiskRestoreConsumed() || info.count === 0) return null;
    setDiskRestoreConsumed(true);
    return info;
  });

  // User-triggered counterpart to the reattach-time stale-argv guard this app
  // used to have (pty.ts's `tryReattach` no longer kills anything on its
  // own — see that function's comment): the ONLY way a stale session's argv
  // ever gets refreshed now is this explicit action, wired to
  // StaleArgvChip.tsx's restart button. Reuses `respawnSession` exactly as
  // `restoreFromDisk` does, so this is the same code path as a normal
  // boot-time respawn, just triggered by the user instead of app launch.
  //
  // `shouldResume` gate: a claude session with no captured `claudeSessionId`
  // (pre-hooks-firing, or a very old record) would respawn with NO `--resume`
  // flag at all — a brand-new, empty conversation, not a refreshed one. That
  // would silently blow away the user's history, which is strictly worse
  // than leaving the stale argv in place, so this refuses instead and hands
  // the renderer a reason to show.
  handle('sessions:restartStale', async (_e, id: string): Promise<RestartStaleResult> => {
    const record = getSessionRegistry().find((s) => s.id === id);
    if (!record) return { ok: false, reason: 'session not found' };
    if (!shouldResume(record)) {
      return { ok: false, reason: "can't safely restart — no captured conversation id to resume" };
    }
    const outcome = await respawnSession(ptyManager, record, {
      harnessHomeDir: getHarnessHomeDir(),
      defaultAgentProvider: await getDefaultAgentProvider()
    });
    if (!outcome.ok) return { ok: false, reason: outcome.fallbackReason ?? 'restart failed' };
    setSessionRegistry(
      getSessionRegistry().map((s) =>
        s.id === id ? { ...s, staleArgv: false, tool: undefined, toolTarget: undefined, looping: false } : s
      )
    );
    return { ok: true };
  });
}
