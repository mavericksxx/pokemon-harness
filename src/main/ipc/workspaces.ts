import { basename } from 'node:path';
import { handle } from './handle';
import { saveWorkspaceRegistry } from '../workspacePersistence';
import { DEFAULT_WORKSPACE_ID, type WorkspaceRecord, type WorkspaceSnapshot } from '../../shared/workspaceTypes';
import type { PtyManager } from '../pty';
import type { SessionPersistence } from '../sessionPersistence';
import type { DiskRestoreInfo, SessionRecord } from '../../shared/types';

export interface WorkspacesIpcDeps {
  ptyManager: PtyManager;
  sessionPersistence: SessionPersistence;
  getWorkspaceRegistry: () => WorkspaceSnapshot;
  setWorkspaceRegistry: (snapshot: WorkspaceSnapshot) => void;
  getHarnessHomeDir: () => string;
  getDiskRestorePromise: () => Promise<DiskRestoreInfo>;
  getSessionRegistry: () => SessionRecord[];
  setSessionRegistry: (sessions: SessionRecord[]) => void;
  getLastSelectedId: () => string | null;
}

export function registerWorkspacesIpc(deps: WorkspacesIpcDeps): void {
  const {
    ptyManager,
    sessionPersistence,
    getWorkspaceRegistry,
    setWorkspaceRegistry,
    getHarnessHomeDir,
    getDiskRestorePromise,
    getSessionRegistry,
    setSessionRegistry,
    getLastSelectedId
  } = deps;

  // ─── Workspaces (Phase 8.7) ─────────────────────────────────────────────────
  // Every handler here returns the FULL current snapshot (not just the one
  // field that changed) so the renderer always hydrates from one authoritative
  // source instead of patching its local copy — most load-bearing for delete,
  // where main may have to pick a new active workspace itself.
  handle('workspaces:list', async () => {
    // workspaceRegistry is populated inside restoreFromDisk() — await the same
    // promise sessions:restore does so this never races ahead of it.
    await getDiskRestorePromise();
    return getWorkspaceRegistry();
  });

  handle('workspaces:create', (_e, name: string, primaryFolder: string) => {
    const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const workspace: WorkspaceRecord = {
      id,
      name: name.trim() || basename(primaryFolder.replace(/\/+$/, '')) || 'new garden',
      primaryFolder,
      createdAt: Date.now()
    };
    // A freshly created workspace becomes the active one immediately — there's
    // no reason to create one and keep looking at another.
    const workspaceRegistry = {
      workspaces: [...getWorkspaceRegistry().workspaces, workspace],
      activeWorkspaceId: id
    };
    setWorkspaceRegistry(workspaceRegistry);
    saveWorkspaceRegistry(getHarnessHomeDir(), workspaceRegistry);
    return { ok: true, ...workspaceRegistry };
  });

  handle('workspaces:rename', (_e, id: string, name: string) => {
    const trimmed = name.trim();
    let workspaceRegistry = getWorkspaceRegistry();
    if (trimmed) {
      workspaceRegistry = {
        ...workspaceRegistry,
        workspaces: workspaceRegistry.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
      };
      setWorkspaceRegistry(workspaceRegistry);
      saveWorkspaceRegistry(getHarnessHomeDir(), workspaceRegistry);
    }
    return { ok: true, ...workspaceRegistry };
  });

  handle('workspaces:update', (_e, id: string, fields: { name?: string; primaryFolder?: string; accent?: number }) => {
    let workspaceRegistry = getWorkspaceRegistry();
    if (workspaceRegistry.workspaces.some((workspace) => workspace.id === id)) {
      workspaceRegistry = {
        ...workspaceRegistry,
        workspaces: workspaceRegistry.workspaces.map((workspace) =>
          workspace.id === id
            ? {
                ...workspace,
                ...(fields.name?.trim() ? { name: fields.name.trim() } : {}),
                ...(fields.primaryFolder?.trim() ? { primaryFolder: fields.primaryFolder.trim() } : {}),
                ...(fields.accent !== undefined ? { accent: fields.accent } : {})
              }
            : workspace
        )
      };
      setWorkspaceRegistry(workspaceRegistry);
      saveWorkspaceRegistry(getHarnessHomeDir(), workspaceRegistry);
    }
    return { ok: true, ...workspaceRegistry };
  });

  handle('workspaces:setActive', (_e, id: string) => {
    let workspaceRegistry = getWorkspaceRegistry();
    if (workspaceRegistry.workspaces.some((w) => w.id === id) && id !== workspaceRegistry.activeWorkspaceId) {
      workspaceRegistry = { ...workspaceRegistry, activeWorkspaceId: id };
      setWorkspaceRegistry(workspaceRegistry);
      saveWorkspaceRegistry(getHarnessHomeDir(), workspaceRegistry);
    }
    return { ok: true, ...workspaceRegistry };
  });

  handle('workspaces:delete', (_e, id: string) => {
    let workspaceRegistry = getWorkspaceRegistry();
    if (workspaceRegistry.workspaces.length <= 1) {
      return { ok: false, error: "can't delete your only workspace.", ...workspaceRegistry };
    }
    // Authoritative liveness check (ptyManager, not merely `status !== 'done'`
    // — same distinction main draws everywhere else it counts live sessions)
    // — the renderer is expected to only ever offer delete once its own view
    // agrees there's nothing live left, but this is the actual guard.
    const liveIds = new Set(ptyManager.list().map((p) => p.id));
    // Arceus (Phase 8.8) is excluded from both checks below: he isn't really
    // "in" whatever workspace his absent workspaceId would otherwise default
    // to, so his liveness must never block a workspace delete, and he must
    // never be dropped as if he were that workspace's orphaned session.
    const hasLiveSession = getSessionRegistry().some(
      (s) => !s.isArceus && (s.workspaceId ?? DEFAULT_WORKSPACE_ID) === id && liveIds.has(s.id)
    );
    if (hasLiveSession) {
      return { ok: false, error: 'this workspace still has running sessions.', ...workspaceRegistry };
    }

    // Drop this workspace's persisted-dead sessions (finished-but-still-listed
    // records) along with it, so deleting a workspace never leaves an orphaned
    // entry with a workspaceId nothing in the registry owns anymore.
    const sessionRegistry = getSessionRegistry().filter(
      (s) => s.isArceus || (s.workspaceId ?? DEFAULT_WORKSPACE_ID) !== id
    );
    setSessionRegistry(sessionRegistry);
    sessionPersistence.schedule({ sessions: sessionRegistry, lastSelectedId: getLastSelectedId() });

    const workspaces = workspaceRegistry.workspaces.filter((w) => w.id !== id);
    const activeWorkspaceId =
      workspaceRegistry.activeWorkspaceId === id ? workspaces[0].id : workspaceRegistry.activeWorkspaceId;
    workspaceRegistry = { workspaces, activeWorkspaceId };
    setWorkspaceRegistry(workspaceRegistry);
    saveWorkspaceRegistry(getHarnessHomeDir(), workspaceRegistry);
    return { ok: true, ...workspaceRegistry };
  });
}
