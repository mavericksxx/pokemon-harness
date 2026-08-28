import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog';
import { DeleteWorkspaceDialog } from '@/components/DeleteWorkspaceDialog';
import { isGlobalSession } from '@shared/arceus';
import type { WorkspaceRecord } from '@shared/workspaceTypes';
import { SproutIcon, TrashIcon } from '@/components/icons';

/** Compact workspace switcher (Phase 8.7) — current workspace name in the
 *  topbar (the session chips it used to hold moved to the bottom roster
 *  strip, freeing this space), opening a dropdown to switch/rename/delete
 *  or create a new one. Cmd/Ctrl+Shift+1..9 (App.tsx) switches directly
 *  without opening this at all. */
export function WorkspaceSwitcher(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const sessions = useStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceRecord | null>(null);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        setRenamingId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const startRename = (w: WorkspaceRecord): void => {
    setRenamingId(w.id);
    setRenameValue(w.name);
  };

  const commitRename = (id: string): void => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (trimmed) void renameWorkspace(id, trimmed);
  };

  /** A workspace can only be deleted once none of its sessions are still
   *  live (`status !== 'done'`) — matches the definition SettingsPanel's
   *  own keep-awake "N sessions live" hint already uses. Main re-checks
   *  this authoritatively (ptyManager) before actually deleting. */
  // Arceus (Phase 8.8) is excluded from both counts: he doesn't "belong" to
  // whatever workspace his absent workspaceId would otherwise default to,
  // so his liveness must never block (or his death never enable) deleting
  // the workspace that default happens to resolve to.
  const liveCount = (workspaceId: string): number =>
    sessions.filter((s) => !isGlobalSession(s) && sessionWorkspaceId(s) === workspaceId && s.status !== 'done').length;
  const deadCount = (workspaceId: string): number =>
    sessions.filter((s) => !isGlobalSession(s) && sessionWorkspaceId(s) === workspaceId && s.status === 'done').length;

  return (
    <div className="workspace-switcher">
      <button
        type="button"
        className="workspace-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="workspace-switcher-glyph" aria-hidden="true">
          <SproutIcon />
        </span>
        <span className="workspace-switcher-name">{active?.name ?? 'garden'}</span>
        <span className="workspace-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className="workspace-switcher-catcher" onClick={() => setOpen(false)} />
          <div className="workspace-switcher-menu" role="menu">
            {workspaces.map((w, i) => {
              const canDelete = workspaces.length > 1 && liveCount(w.id) === 0;
              return (
                <div key={w.id} className={w.id === activeWorkspaceId ? 'workspace-row active' : 'workspace-row'}>
                  {renamingId === w.id ? (
                    <input
                      className="workspace-row-rename"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(w.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(w.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="workspace-row-name"
                      role="menuitemradio"
                      aria-checked={w.id === activeWorkspaceId}
                      onClick={() => {
                        void setActiveWorkspace(w.id);
                        setOpen(false);
                      }}
                      title={w.primaryFolder}
                    >
                      {w.name}
                      {i < 9 && <span className="workspace-row-shortcut">⌘⇧{i + 1}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon workspace-row-action"
                    aria-label={`rename ${w.name}`}
                    title="rename"
                    onClick={() => startRename(w)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon workspace-row-action"
                    aria-label={`delete ${w.name}`}
                    title={
                      canDelete
                        ? 'delete this workspace'
                        : workspaces.length <= 1
                          ? "can't delete your only workspace"
                          : 'still has running sessions — stop them first'
                    }
                    disabled={!canDelete}
                    onClick={() => setDeleteTarget(w)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="workspace-switcher-new"
              onClick={() => {
                setNewOpen(true);
                setOpen(false);
              }}
            >
              + new workspace
            </button>
          </div>
        </>
      )}

      {newOpen && <NewWorkspaceDialog onClose={() => setNewOpen(false)} />}
      {deleteTarget && (
        <DeleteWorkspaceDialog
          workspace={deleteTarget}
          deadSessionCount={deadCount(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
