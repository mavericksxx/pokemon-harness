import { useEffect, useState } from 'react';
import { saveArceusSummonConfig, summonArceus, summonArceusDevStandin } from '@/arceus';

interface Props {
  onClose(): void;
}

/** "Summon Arceus" mini-dialog (Phase 8.8 §1) — folder (defaults to the
 *  harness home dir), a model field (same optional-text shape as
 *  NewSessionDialog's), and an auto-mode toggle (same copy convention as
 *  NewSessionDialog's, since Arceus always spawns as a real `claude`
 *  session). If `claude` isn't installed, explains instead of attempting a
 *  spawn that would just fail. */
export function SummonArceusDialog({ onClose }: Props): JSX.Element {
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [autoMode, setAutoMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while resolving — the dialog shows nothing conclusive until both
  // IPC round-trips settle, rather than flashing the wrong state first.
  const [claudeAvailable, setClaudeAvailable] = useState<boolean | null>(null);
  const [devStandin, setDevStandin] = useState(false);

  useEffect(() => {
    void window.api.getHarnessHomePath().then(setCwd);
    void window.api.isCommandAvailable('claude').then(setClaudeAvailable);
    void window.api.getArceusDevStandin().then(setDevStandin);
  }, []);

  const pickFolder = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setCwd(picked);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!cwd.trim()) {
      setError('Choose a folder.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const req = { cwd: cwd.trim(), model: model.trim() || undefined, autoMode };
      if (devStandin) await summonArceusDevStandin(req);
      else await summonArceus(req);
      // Summon-once (Phase 8.9) — this dialog only ever shows for a genuine
      // first run (or after a Settings reset), so a successful summon HERE
      // is exactly the "onboard once" moment: persist it so every later
      // launch (or chip click if he's not live) auto-summons silently
      // instead of asking again. Never called from the auto path itself.
      void saveArceusSummonConfig(req);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (claudeAvailable === false) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>summon arceus</h2>
          <p className="hint">
            Arceus is a real Claude Code session — the <code>claude</code> CLI isn&apos;t on your PATH, so there&apos;s
            nothing to summon him into. Install Claude Code, then try again.
          </p>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>summon arceus</h2>
        <p className="hint">The orchestrator of this garden — one, global, seen from every workspace.</p>

        <label>
          Folder
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <button type="button" onClick={pickFolder}>
              Browse…
            </button>
          </div>
          <p className="hint">Defaults to the harness home folder.</p>
        </label>

        <label>
          Model <span className="hint">(optional)</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="leave blank for the CLI default"
            spellCheck={false}
          />
        </label>

        <label className="new-session-auto-mode">
          <input type="checkbox" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
          auto mode — arceus acts without asking first
          <span className="hint">off: arceus pauses for your approval in the terminal</span>
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Summoning…' : 'Summon'}
          </button>
        </div>
      </form>
    </div>
  );
}
