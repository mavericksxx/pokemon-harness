import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog';
import { DeleteWorkspaceDialog } from '@/components/DeleteWorkspaceDialog';
import { isGlobalSession } from '@shared/arceus';
import type { WorkspaceRecord } from '@shared/workspaceTypes';
import { TrashIcon } from '@/components/icons';

/** Gardens (workspaces), in the topbar (garden-picker merge — replaces both
 *  the old always-visible rename/delete/change-folder icon row AND the
 *  separate "+N ▾" overflow chip that used to sit beside it with ONE click
 *  target: the active garden's name. Clicking it opens a single popover
 *  (`.garden-picker-menu`, same anchored-popover idiom as AudioPopover.tsx —
 *  wrapper ref + document-level outside-pointerdown + Escape) holding
 *  everything that used to be spread across the row: the list of other
 *  gardens to switch to (was the "+N ▾" dropdown), and rename/delete/change-
 *  folder for the CURRENT garden (was the hover-revealed icon trio). All the
 *  underlying handlers are unchanged from that version — only how they're
 *  triggered moved. Cmd/Ctrl+Shift+1..9 (App.tsx) still switches gardens
 *  directly without touching this component at all.
 *
 *  One control grammar pass: this is one of only two level-1 BORDERED
 *  controls in the topbar (the other is the view-mode segmented group) — it
 *  holds state (which garden is active), so it keeps a permanent panel-2/
 *  hairline box rather than the ghost treatment. Moved from the topbar's
 *  left end (next to Arceus's old topbar summon chip) to the right cluster, beside
 *  HARNESS.md; the trigger now reads `▣ <name> ▾` — the caret is new, since
 *  nothing used to announce that this button opens a menu rather than just
 *  switching gardens directly. */
export function WorkspaceSwitcher(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const sessions = useStore((s) => s.sessions);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceRecord | null>(null);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);
  const pushToast = useStore((s) => s.pushToast);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  const startRename = (w: WorkspaceRecord): void => {
    setMenuOpen(false);
    setRenaming(true);
    setRenameValue(w.name);
  };

  const commitRename = (id: string): void => {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed) void renameWorkspace(id, trimmed);
  };

  const changeFolder = async (workspace: WorkspaceRecord): Promise<void> => {
    setMenuOpen(false);
    const folder = await window.api.chooseFolder();
    if (!folder) return;
    try {
      await updateWorkspace(workspace.id, { primaryFolder: folder });
    } catch (err) {
      pushToast(`couldn't change folder: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Outside-click dismissal follows the document-level pointerdown +
  // wrapper-ref `.contains()` pattern established by AudioPopover.tsx /
  // OverflowChipRow.tsx.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  if (!activeWorkspace) return <></>;

  const otherWorkspaces = workspaces.filter((w) => w.id !== activeWorkspace.id);
  const canDelete = workspaces.length > 1 && liveCount(activeWorkspace.id) === 0;
  const i = workspaces.findIndex((w) => w.id === activeWorkspace.id);

  return (
    <div className="garden-picker" ref={wrapperRef}>
      {renaming ? (
        <input
          className="garden-picker-rename"
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => commitRename(activeWorkspace.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(activeWorkspace.id);
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="garden-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={i >= 0 && i < 9 ? `${activeWorkspace.primaryFolder} (⌘⇧${i + 1})` : activeWorkspace.primaryFolder}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span aria-hidden="true">▣</span>
          <span className="garden-picker-trigger-name">{activeWorkspace.name}</span>
          <span aria-hidden="true">▾</span>
        </button>
      )}

      {menuOpen && (
        <div className="garden-picker-menu" role="menu" aria-label="gardens">
          <div className="garden-picker-menu-header">
            <div className="garden-picker-menu-name">{activeWorkspace.name}</div>
            <div className="garden-picker-menu-path" title={activeWorkspace.primaryFolder}>
              {activeWorkspace.primaryFolder}
            </div>
          </div>

          {otherWorkspaces.length > 0 && (
            <div className="garden-picker-menu-list">
              {otherWorkspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitem"
                  className="garden-picker-menu-item"
                  title={w.primaryFolder}
                  onClick={() => {
                    void setActiveWorkspace(w.id);
                    setMenuOpen(false);
                  }}
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}

          <div className="garden-picker-menu-actions">
            <button
              type="button"
              className="garden-picker-menu-item"
              title="change folder…"
              onClick={() => void changeFolder(activeWorkspace)}
            >
              ↗ change folder…
            </button>
            <button
              type="button"
              className="garden-picker-menu-item"
              title="rename"
              onClick={() => startRename(activeWorkspace)}
            >
              ✎ rename
            </button>
            <button
              type="button"
              className="garden-picker-menu-item danger"
              title={
                canDelete
                  ? 'delete this garden'
                  : workspaces.length <= 1
                    ? "can't delete your only garden"
                    : 'still has running agents — stop them first'
              }
              disabled={!canDelete}
              onClick={() => {
                setMenuOpen(false);
                setDeleteTarget(activeWorkspace);
              }}
            >
              <TrashIcon /> delete
            </button>
          </div>

          <div className="garden-picker-menu-footer">
            <button
              type="button"
              className="garden-picker-new"
              onClick={() => {
                setMenuOpen(false);
                setNewOpen(true);
              }}
            >
              + new garden
            </button>
          </div>
        </div>
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
