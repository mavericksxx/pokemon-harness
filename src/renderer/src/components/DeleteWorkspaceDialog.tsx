import { useState } from 'react';
import { useWorkspaceStore } from '@/store/workspaceStore';
import type { WorkspaceRecord } from '@shared/workspaceTypes';

interface Props {
  workspace: WorkspaceRecord;
  /** How many of this workspace's sessions are done-but-still-listed
   *  (WorkspaceSwitcher already confirmed there's nothing LIVE, or this
   *  dialog wouldn't be reachable) — shown so deleting doesn't silently
   *  drop tabs the user forgot were there. */
  deadSessionCount: number;
  onClose(): void;
}

/** Delete-workspace confirm (Phase 8.7) — styled like the quit dialog
 *  (warm copy, a plain "cancel" beside a `.danger` destructive action), but
 *  a simpler two-button shape: unlike quitting, there's no "session state
 *  is about to be lost" risk here — WorkspaceSwitcher only offers this once
 *  the workspace has no live sessions left. */
export function DeleteWorkspaceDialog({ workspace, deadSessionCount, onClose }: Props): JSX.Element {
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    const err = await deleteWorkspace(workspace.id);
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>delete {workspace.name}?</h2>
        <p className="hint">
          {deadSessionCount > 0
            ? `Its ${deadSessionCount} finished session${deadSessionCount === 1 ? '' : 's'} go with it. This can't be undone.`
            : "This can't be undone."}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="button" className="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'deleting…' : 'delete workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
