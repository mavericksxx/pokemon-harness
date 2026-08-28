import { useState } from 'react';
import { useStore } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog';
import { DeleteWorkspaceDialog } from '@/components/DeleteWorkspaceDialog';
import { isGlobalSession } from '@shared/arceus';
import type { WorkspaceRecord } from '@shared/workspaceTypes';
import { TrashIcon } from '@/components/icons';

/** Gardens (workspaces), inline in the topbar (parity sweep — replaces the
 *  old dropdown-menu switcher: with Arceus's chip now leading the row and
 *  his roster card gone, there was finally room to put the gardens
 *  themselves in the chrome instead of behind a click). Every garden is a
 *  chip — click to switch. Rename/delete only need to be reachable for
 *  WHICHEVER garden is active (you rename/delete the one you're looking at,
 *  same as before, just no longer behind a menu to open first) — the active
 *  chip alone grows a rename (✎) and delete affordance, folded into the
 *  chip itself and hover/focus-revealed at its right edge (index.css's
 *  `.garden-chip-action` — topbar overhaul, was two bare floating icons
 *  beside the chip); every other chip is just a plain switch button.
 *  Cmd/Ctrl+Shift+1..9 (App.tsx) switches
 *  directly without touching this component at all — the per-chip shortcut
 *  hint moved from a visible label into each chip's tooltip to keep the row
 *  compact. */
export function WorkspaceSwitcher(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const sessions = useStore((s) => s.sessions);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceRecord | null>(null);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);

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
  // Arceus is excluded from both counts: he doesn't "belong" to whatever
  // workspace his absent workspaceId would otherwise default to, so his
  // liveness must never block (or his death never enable) deleting the
  // workspace that default happens to resolve to.
  const liveCount = (workspaceId: string): number =>
    sessions.filter((s) => !isGlobalSession(s) && sessionWorkspaceId(s) === workspaceId && s.status !== 'done').length;
  const deadCount = (workspaceId: string): number =>
    sessions.filter((s) => !isGlobalSession(s) && sessionWorkspaceId(s) === workspaceId && s.status === 'done').length;

  return (
    <nav className="garden-chips" aria-label="gardens">
      {workspaces.map((w, i) => {
        const active = w.id === activeWorkspaceId;
        if (renamingId === w.id) {
          return (
            <input
              key={w.id}
              className="garden-chip-rename"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(w.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(w.id);
                if (e.key === 'Escape') setRenamingId(null);
              }}
            />
          );
        }
        const canDelete = workspaces.length > 1 && liveCount(w.id) === 0;
        return (
          <span key={w.id} className={active ? 'garden-chip active' : 'garden-chip'}>
            <button
              type="button"
              className="garden-chip-name"
              aria-pressed={active}
              onClick={() => void setActiveWorkspace(w.id)}
              title={i < 9 ? `${w.primaryFolder} (⌘⇧${i + 1})` : w.primaryFolder}
            >
              {w.name}
            </button>
            {active && (
              <>
                <button
                  type="button"
                  className="icon garden-chip-action"
                  aria-label={`rename ${w.name}`}
                  title="rename"
                  onClick={() => startRename(w)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon garden-chip-action"
                  aria-label={`delete ${w.name}`}
                  title={
                    canDelete
                      ? 'delete this garden'
                      : workspaces.length <= 1
                        ? "can't delete your only garden"
                        : 'still has running agents — stop them first'
                  }
                  disabled={!canDelete}
                  onClick={() => setDeleteTarget(w)}
                >
                  <TrashIcon />
                </button>
              </>
            )}
          </span>
        );
      })}
      <button type="button" className="garden-chip-new" onClick={() => setNewOpen(true)}>
        + new garden
      </button>

      {newOpen && <NewWorkspaceDialog onClose={() => setNewOpen(false)} />}
      {deleteTarget && (
        <DeleteWorkspaceDialog
          workspace={deleteTarget}
          deadSessionCount={deadCount(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </nav>
  );
}
