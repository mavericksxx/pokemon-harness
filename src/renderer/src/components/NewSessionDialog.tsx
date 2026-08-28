import { useState } from 'react';
import { AGENT_PROVIDERS, DEFAULT_PROVIDER, PROVIDER_LIST, type AgentProviderId } from '@shared/agentProvider';
import { startSession } from '@/sessions';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pickFreeLine } from '@/scene/garden/showdownArt';
import { baseStageOf, chainLabel, speciesEntry } from '@/scene/garden/dexData';
import { PokemonPicker } from './PokemonPicker';

interface Props {
  onClose(): void;
}

export function NewSessionDialog({ onClose }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const takenLines = new Set(sessions.map((s) => s.line));
  // Random default, chosen once on open from whichever bundled line is free.
  const [pokemon, setPokemon] = useState(() => pickFreeLine([...takenLines]).name);
  const [provider, setProvider] = useState<AgentProviderId>(DEFAULT_PROVIDER);
  // Prefilled from the ACTIVE workspace's primary folder (Phase 8.7) — still
  // freely editable; this is a starting point, not a constraint (a session's
  // cwd can be anything, same as before workspaces existed).
  const activeWorkspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const [cwd, setCwd] = useState(() => activeWorkspace?.primaryFolder ?? '');
  const [command, setCommand] = useState(AGENT_PROVIDERS[DEFAULT_PROVIDER].defaultCommand);
  const [model, setModel] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appSettings = useAppSettingsStore((s) => s.settings);
  // Per-session override of the provider's auto-permission-mode setting
  // (parity sweep item 1) — defaults to whatever the Settings panel has for
  // THIS provider, editable per session from here.
  const [autoMode, setAutoMode] = useState(() => appSettings.autoModeByProvider[DEFAULT_PROVIDER] ?? false);
  const recentFolders = useAppSettingsStore((s) => s.settings.recentFolders);

  const chosen = speciesEntry(pokemon);
  const base = baseStageOf(pokemon);
  const chain = chainLabel(base.line);
  const isBaseStage = chosen ? chosen.stage === 1 : true;
  const note = isBaseStage
    ? chain
    : `${chosen?.name ?? pokemon} joins as ${base.name} — it'll evolve as your agent works (${chain})`;

  const pickFolder = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setCwd(picked);
  };

  const onProvider = (id: AgentProviderId): void => {
    setProvider(id);
    if (id === 'shell') {
      // The real $SHELL can only be read main-side (item 3 §3) — the
      // registry's `defaultCommand` for this preset is a fallback only, used
      // if this IPC round-trip somehow doesn't resolve before submit.
      void window.api.getDefaultShell().then((shell) => setCommand(shell));
    } else if (id === 'cursor-agent') {
      // Cursor has shipped its CLI under two different binary names
      // (`cursor-agent`, and `agent` on some installs) — BACKLOG.md's
      // "cursor-agent binary name check" item. Prefill with the registry
      // default first so the field isn't empty while resolving, then swap
      // to whichever name actually resolves on PATH. Neither found: leaves
      // the registry default in place, same as before this fix.
      setCommand(AGENT_PROVIDERS[id].defaultCommand);
      void (async (): Promise<void> => {
        if (await window.api.isCommandAvailable('cursor-agent')) return;
        if (await window.api.isCommandAvailable('agent')) setCommand('agent');
      })();
    } else {
      setCommand(AGENT_PROVIDERS[id].defaultCommand);
    }
    setAutoMode(appSettings.autoModeByProvider[id] ?? false);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!cwd.trim()) {
      setError('choose a working directory.');
      return;
    }
    if (takenLines.has(base.line)) {
      setError(`${base.name}'s line is already out in the garden.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await startSession({
        provider,
        cwd: cwd.trim(),
        command,
        model: model.trim() || undefined,
        title,
        pokemon,
        autoMode
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>new session</h2>

        <label>
          agent
          <select value={provider} onChange={(e) => onProvider(e.target.value as AgentProviderId)}>
            {PROVIDER_LIST.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          working directory
          <div className="row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~/Developer/my-project"
              spellCheck={false}
              list="recent-folders"
            />
            <button type="button" onClick={pickFolder}>
              browse…
            </button>
          </div>
          {/* Recent-repos quick-pick (parity sweep item 6) — a native
              datalist combo: typeable like before, with the last ~10 working
              directories offered as suggestions, newest first. */}
          <datalist id="recent-folders">
            {recentFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>

        <label>
          command
          <input value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        </label>

        {AGENT_PROVIDERS[provider].autoModeArgs && (
          <label className="new-session-auto-mode">
            <input type="checkbox" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
            auto mode — agents act without asking first
            <span className="hint">off: agents pause for your approval in the terminal</span>
          </label>
        )}

        {AGENT_PROVIDERS[provider].supportsModel && (
          <label>
            model <span className="hint">(optional)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="leave blank for the CLI default"
              spellCheck={false}
            />
          </label>
        )}

        <label>
          name <span className="hint">(optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="defaults to the folder name"
          />
        </label>

        <label>
          pokemon <span className="hint">(one per evolution line)</span>
          <PokemonPicker value={pokemon} onChange={setPokemon} />
          <p className="hint pokemon-note">{note}</p>
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'starting…' : 'start'}
          </button>
        </div>
      </form>
    </div>
  );
}
