import { useEffect, useState } from 'react';
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { saveArceusSummonConfig, summonArceus, summonArceusDevStandin } from '@/arceus';

interface Props {
  onClose(): void;
}

/** Providers Arceus can spawn as (provider-aware Arceus, BACKLOG item 1) —
 *  same claude/codex-only scope as WelcomeDialog's picker: cursor-agent's
 *  summon/first-prompt path was never verified for him. */
const ARCEUS_PROVIDERS: AgentProviderId[] = ['claude', 'codex'];

/** "Summon Arceus" mini-dialog (Phase 8.8 §1, provider-aware since BACKLOG
 *  item 1) — a provider select (defaults to the app's own default agent
 *  provider — settings' "default agent provider" row), folder (defaults to
 *  the harness home dir), a model field (same optional-text shape as
 *  NewSessionDialog's), and an auto-mode toggle (same copy convention as
 *  NewSessionDialog's). If the selected provider's CLI isn't installed,
 *  explains inline instead of attempting a spawn that would just fail —
 *  inline rather than replacing the whole form (as this dialog did back
 *  when it only ever offered claude) so switching providers is a way OUT
 *  of that state, not a dead end. */
export function SummonArceusDialog({ onClose }: Props): JSX.Element {
  const configuredProvider = useAppSettingsStore((s) => s.settings.defaultAgentProvider);
  const [provider, setProvider] = useState<AgentProviderId>(
    ARCEUS_PROVIDERS.includes(configuredProvider) ? configuredProvider : 'claude'
  );
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [autoMode, setAutoMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while resolving — the dialog shows nothing conclusive until the
  // IPC round-trip settles, rather than flashing the wrong state first.
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const [devStandin, setDevStandin] = useState(false);

  useEffect(() => {
    void window.api.getHarnessHomePath().then(setCwd);
    void window.api.getArceusDevStandin().then(setDevStandin);
  }, []);

  // Re-checked on every provider switch — a claude machine may not have
  // codex on PATH, or vice versa.
  useEffect(() => {
    setCliAvailable(null);
    void window.api.isCommandAvailable(AGENT_PROVIDERS[provider].defaultCommand).then(setCliAvailable);
  }, [provider]);

  const pickFolder = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setCwd(picked);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!cwd.trim()) {
      setError('choose a folder.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const req = { cwd: cwd.trim(), model: model.trim() || undefined, autoMode, provider };
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>summon arceus</h2>
        <p className="hint">the orchestrator of this garden — one, global, seen from every workspace.</p>

        <label>
          provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProviderId)}>
            {ARCEUS_PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {AGENT_PROVIDERS[id].label}
              </option>
            ))}
          </select>
          {/* Relay ("tell chikorita to do X") only works for a claude
              Arceus — it reads his own Claude Code hooks to learn where his
              transcript lives, and this app doesn't wire hooks for a
              top-level codex session at all. A codex Arceus still chats and
              takes dispatches normally; he just can't hand work to other
              agents on his own. */}
          {provider === 'codex' && (
            <p className="hint">relaying tasks to other agents (@@relay) currently only works for claude.</p>
          )}
        </label>

        <label>
          folder
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <button type="button" onClick={pickFolder}>
              browse…
            </button>
          </div>
          <p className="hint">defaults to the harness home folder.</p>
        </label>

        {cliAvailable === false && (
          <p className="error">
            the <code>{AGENT_PROVIDERS[provider].defaultCommand}</code> CLI isn&apos;t on your PATH — install{' '}
            {AGENT_PROVIDERS[provider].label}, or pick a different provider above.
          </p>
        )}

        <label>
          model <span className="hint">(optional)</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="leave blank for the CLI default"
            spellCheck={false}
          />
        </label>

        {AGENT_PROVIDERS[provider].autoModeArgs && (
          <label className="new-session-auto-mode">
            <input type="checkbox" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
            auto mode — arceus acts without asking first
            <span className="hint">off: arceus pauses for your approval in the terminal</span>
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="primary" disabled={busy || cliAvailable === false}>
            {busy ? 'summoning…' : 'summon'}
          </button>
        </div>
      </form>
    </div>
  );
}
