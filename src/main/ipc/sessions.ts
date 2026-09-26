import { handle } from './handle';
import { writeArceusRosterFile } from '../arceusRosterFile';
import type { PtyManager } from '../pty';
import type { SessionPersistence } from '../sessionPersistence';
import type { PokeRelay } from '../pokeTools';
import type { CostWatcher } from '../costWatcher';
import type { TaskNotificationWatcher } from '../taskNotificationWatcher';
import type { OutsideWriteDetector } from '../outsideWriteDetector';
import type { DiskRestoreInfo, ReloadSessionResult, SessionRecord } from '../../shared/types';
import type { WorkspaceSnapshot } from '../../shared/workspaceTypes';
import { respawnArgs, shouldResume } from '../sessionRespawn';
import { log } from '../diagnostics';

/** External sessions plan §7 step 4 — how long `sessions:reload` waits for
 *  the old process to actually exit before giving up rather than risking two
 *  writers on the same `--resume` transcript (see `killAndAwaitExit`'s own
 *  comment in pty.ts). */
const RELOAD_KILL_TIMEOUT_MS = 5000;

export interface SessionsIpcDeps {
  ptyManager: PtyManager;
  sessionPersistence: SessionPersistence;
  pokeRelay: PokeRelay;
  costWatcher: CostWatcher;
  taskNotificationWatcher: TaskNotificationWatcher;
  outsideWriteDetector: OutsideWriteDetector;
  notifyStatusTransitions: (sessions: SessionRecord[], selectedId: string | null) => void;
  getSessionRegistry: () => SessionRecord[];
  setSessionRegistry: (sessions: SessionRecord[]) => void;
  getLastSelectedId: () => string | null;
  setLastSelectedId: (id: string | null) => void;
  getHarnessHomeDir: () => string;
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
    outsideWriteDetector,
    notifyStatusTransitions,
    getSessionRegistry,
    setSessionRegistry,
    getLastSelectedId,
    setLastSelectedId,
    getHarnessHomeDir,
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
    outsideWriteDetector.onSessionsChecked(sessions);
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

  // External sessions plan §7 step 4 — kill the session's current process,
  // AWAIT its real exit, then respawn via `claude --resume`. Never reattach
  // (this id is definitionally already live under this app, unlike the
  // stale-keeper-reattach case `5bbfe4b` originally built this pattern for):
  // the point here is a full kill+resume cycle so the terminal redraws with
  // whatever another surface appended to the transcript while this session
  // sat idle (plan §2 item 5, §7 step 5's detector). This app never kills a
  // session as a side effect of anything else (f58aa3c's hard rule) — this
  // explicit call (a user-clicked chip, or the auto-reload gate opening) is
  // the one place that does, and only for `continuedFrom` sessions per the
  // caller's own scoping.
  // D9 fix — per-id in-flight guard: two overlapping `sessions:reload` calls
  // for the SAME id (e.g. the auto-reload gate opening right as the user
  // clicks the manual chip) must never both run kill->await->respawn at
  // once — the second call's kill would race the first's respawn, right
  // back into the two-writers hazard `killAndAwaitExit` exists to prevent.
  const reloadsInFlight = new Set<string>();

  handle('sessions:reload', async (_e, id: string): Promise<ReloadSessionResult> => {
    if (reloadsInFlight.has(id)) {
      return { ok: false, reason: 'a reload for this session is already in progress' };
    }
    reloadsInFlight.add(id);
    try {
      const record = getSessionRegistry().find((s) => s.id === id);
      if (!record) return { ok: false, reason: 'session not found' };

      // D13 fix — resume from the PERSISTED `claudeSessionId`, not a
      // "live-observed transcript path" override. That override
      // (`HookBridge.getLiveTranscriptPath`) is keyed only on this session's
      // `harness_agent_id`, which a nested `claude -p` run (inherited env,
      // same as the nested-startup hazard hookRouter.ts's SessionStart case
      // guards against) can ALSO write to via its own top-level-shaped
      // hooks — pointing a reload at the nested run's unrelated transcript.
      // `record.claudeSessionId` is now kept current by the revived `/clear`
      // fix (hookBridge.ts's `claudeSessionIdFromPayload`) plus that same
      // nested-startup guard, so it no longer needs a live-path escape hatch
      // here.
      if (!shouldResume(record)) {
        return { ok: false, reason: "can't safely reload — no captured conversation id to resume" };
      }

      const exited = await ptyManager.killAndAwaitExit(id, RELOAD_KILL_TIMEOUT_MS);
      if (!exited) {
        // Never spawn on top of a process we can't confirm is actually dead
        // — the two-writers-on-one-transcript hazard this sequence exists
        // to avoid. `killAndAwaitExit` itself re-tracks the session on this
        // path (D9), so it's left live and untouched; surfaced as a failed
        // reload, never a disconnected card.
        log('pty', 'warn', 'sessions:reload: old process did not exit in time — nothing reloaded', { id });
        return { ok: false, reason: "the old session didn't stop in time — nothing was reloaded" };
      }

      const res = ptyManager.spawn({
        id,
        cwd: record.cwd,
        command: record.command,
        args: respawnArgs(record),
        provider: record.provider,
        cols: 100,
        rows: 30
      });
      if (!res.ok) return { ok: false, reason: res.error ?? 'reload failed to spawn' };

      // Signal (c) — our own reload just resumed; its own SessionStart/
      // growth must never be mistaken for a fresh outside write.
      outsideWriteDetector.rebaseline(id);

      setSessionRegistry(getSessionRegistry().map((s) => (s.id === id ? { ...s, exitCode: undefined } : s)));
      return { ok: true, cwd: res.cwd ?? record.cwd, claudeSessionId: record.claudeSessionId };
    } finally {
      reloadsInFlight.delete(id);
    }
  });
}
