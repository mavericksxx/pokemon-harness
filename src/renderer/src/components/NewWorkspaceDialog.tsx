import { useState } from 'react';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

interface Props {
  onClose(): void;
}

/** "+ New workspace" (Phase 8.7) — name + a primary folder, same
 *  browse-or-type-with-recents shape as NewSessionDialog's working
 *  directory field. Creating switches to the new workspace immediately
 *  (main's `workspaces:create` sets it active) — there's no "create in the
 *  background" option. */
export function NewWorkspaceDialog({ onClose }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const recentFolders = useAppSettingsStore((s) => s.settings.recentFolders);

  const pickFolder = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setFolder(picked);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!folder.trim()) {
      setError('choose a folder for this workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createWorkspace(name, folder.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>new workspace</h2>

        <label>
          name <span className="hint">(optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="defaults to the folder name"
            autoFocus
          />
        </label>

        <label>
          primary folder
          <div className="row">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="~/Developer/my-other-project"
              spellCheck={false}
              list="recent-folders-workspace"
            />
            <button type="button" onClick={pickFolder}>
              browse…
            </button>
          </div>
          <datalist id="recent-folders-workspace">
            {recentFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <p className="hint">new sessions in this workspace default here — any session can still pick another folder.</p>
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'creating…' : 'create'}
          </button>
        </div>
      </form>
    </div>
  );
}
