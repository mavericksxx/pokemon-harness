/** Types shared between main, preload and renderer for workspaces (Phase 8.7)
 *  — named playgrounds, each with its own garden population and sessions.
 *  Persisted as `workspaces.json` in the harness home directory (see
 *  `main/harnessHome.ts`), NOT in Electron's userData — this is one of the
 *  few pieces of state meant to be user-visible on disk.
 */

/** The id every pre-8.7 persisted session implicitly belongs to — a
 *  `SessionRecord` with no `workspaceId` (main/index.ts's `restoreFromDisk`)
 *  is treated as this workspace, and it's also the id the very first
 *  registry ever created uses (see `main/workspacePersistence.ts`'s
 *  `initWorkspaceRegistry`). Not special beyond that: it can be renamed or
 *  deleted like any other workspace once at least one other one exists. */
export const DEFAULT_WORKSPACE_ID = 'default';

export interface WorkspaceRecord {
  id: string;
  name: string;
  /** The folder a New Session dialog opened from this workspace prefills —
   *  "primary" because a workspace isn't strictly one repo (any session's
   *  cwd can differ), just the one this workspace was built around. */
  primaryFolder: string;
  createdAt: number;
  accent?: number;
}

/** What `workspaces:list` returns, and the shape every mutation IPC
 *  (`workspaces:create/rename/setActive/delete`) returns too, so the
 *  renderer always hydrates from one authoritative snapshot rather than
 *  patching its local copy and risking drift — see `workspaces:delete`,
 *  where main may have to pick a new active workspace itself. */
export interface WorkspaceSnapshot {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
}

/** A mutation's result: the fresh snapshot, plus `ok`/`error` for the one
 *  request that can be refused (`workspaces:delete`, when the workspace
 *  still has live sessions, or is the last remaining workspace). `ok` is
 *  always true for create/rename/setActive — they can't fail in a way the
 *  UI needs to react to. */
export interface WorkspaceMutationResult extends WorkspaceSnapshot {
  ok: boolean;
  error?: string;
}
