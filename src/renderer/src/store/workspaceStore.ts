/**
 * Workspace registry store (Phase 8.7) — a client cache of the main-process
 * workspace registry (workspacePersistence.ts, persisted in the harness home
 * directory), same "hydrate from main, mutate via IPC" shape as
 * appSettingsStore.ts. Deliberately separate from `@/store/store.ts`
 * (sessions/garden UI state) for the same reason audioStore.ts and
 * appSettingsStore.ts already are — a different persistence domain.
 *
 * Every mutation (create/rename/setActive/delete) hydrates from the IPC
 * response's full snapshot rather than patching local state — main is the
 * only side that can correctly decide e.g. which workspace becomes active
 * after deleting the current one.
 */
import { create } from 'zustand';
import { useStore, type Session } from '@/store/store';
import { DEFAULT_WORKSPACE_ID, type WorkspaceRecord, type WorkspaceSnapshot } from '@shared/workspaceTypes';

/** A session's workspace, defaulting the implicit id for a pre-8.7 record
 *  that hasn't been migrated in memory yet (shouldn't normally happen —
 *  main stamps a concrete id on both restore and creation — but this is the
 *  one place every consumer reads it through, so a gap anywhere upstream
 *  degrades to "the default workspace" instead of "un-scoped/everywhere"). */
export function sessionWorkspaceId(session: Session): string {
  return session.workspaceId ?? DEFAULT_WORKSPACE_ID;
}

interface WorkspaceState {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
  loaded: boolean;

  hydrate(snapshot: WorkspaceSnapshot): void;
  createWorkspace(name: string, primaryFolder: string): Promise<void>;
  renameWorkspace(id: string, name: string): Promise<void>;
  setActiveWorkspace(id: string): Promise<void>;
  /** Resolves to null on success, or a human-readable reason it was
   *  refused (still has live sessions / it's the only workspace left). */
  deleteWorkspace(id: string): Promise<string | null>;
}

/** Re-points the (globally single) selection at the newly-active workspace's
 *  first session, or clears it — called after every mutation that can change
 *  `activeWorkspaceId` (switch, create, delete). Without this, switching
 *  workspaces would leave `selectedId` pointing at a session in the
 *  workspace you just left: the terminal drawer would keep showing it, and
 *  main's notify gate (`focused && selectedId === session.id`) would
 *  wrongly suppress a blocked/done ping for it — see main/index.ts's
 *  `notifyStatusTransitions`. */
function syncSelectionToWorkspace(activeWorkspaceId: string): void {
  const sessions = useStore.getState().sessions.filter((s) => sessionWorkspaceId(s) === activeWorkspaceId);
  useStore.getState().select(sessions[0]?.id ?? null);
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  loaded: false,

  hydrate: (snapshot) => set({ ...snapshot, loaded: true }),

  createWorkspace: async (name, primaryFolder) => {
    const res = await window.api.createWorkspace(name, primaryFolder);
    set({ workspaces: res.workspaces, activeWorkspaceId: res.activeWorkspaceId });
    syncSelectionToWorkspace(res.activeWorkspaceId);
  },

  renameWorkspace: async (id, name) => {
    const res = await window.api.renameWorkspace(id, name);
    set({ workspaces: res.workspaces, activeWorkspaceId: res.activeWorkspaceId });
  },

  setActiveWorkspace: async (id) => {
    const res = await window.api.setActiveWorkspace(id);
    set({ workspaces: res.workspaces, activeWorkspaceId: res.activeWorkspaceId });
    syncSelectionToWorkspace(res.activeWorkspaceId);
  },

  deleteWorkspace: async (id) => {
    const res = await window.api.deleteWorkspace(id);
    if (!res.ok) return res.error ?? 'Could not delete this workspace.';
    set({ workspaces: res.workspaces, activeWorkspaceId: res.activeWorkspaceId });
    syncSelectionToWorkspace(res.activeWorkspaceId);
    return null;
  }
}));
