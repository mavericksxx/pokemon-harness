import { useState } from 'react';
import { AGENT_PROVIDERS, DEFAULT_PROVIDER, PROVIDER_LIST, type AgentProviderId } from '@shared/agentProvider';
import { startSession } from '@/sessions';
import { useStore } from '@/store/store';
import { pickFreePokemon, POKEMON_ROSTER } from '@/scene/garden/showdownArt';
import { PokemonFace } from './PokemonFace';

interface Props {
  onClose(): void;
}

export function NewSessionDialog({ onClose }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const taken = new Set(sessions.map((s) => s.pokemon));
  // Random default, chosen once on open from whoever is not already out there.
  const [pokemon, setPokemon] = useState(() => pickFreePokemon([...taken]));
  const [provider, setProvider] = useState<AgentProviderId>(DEFAULT_PROVIDER);
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState(AGENT_PROVIDERS[DEFAULT_PROVIDER].defaultCommand);
  const [model, setModel] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFolder = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setCwd(picked);
  };

  const onProvider = (id: AgentProviderId): void => {
    setProvider(id);
    setCommand(AGENT_PROVIDERS[id].defaultCommand);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!cwd.trim()) {
      setError('Choose a working directory.');
      return;
    }
    if (taken.has(pokemon)) {
      setError('That Pokemon is already out in the garden.');
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
        pokemon
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
        <h2>New session</h2>

        <label>
          Agent
          <select value={provider} onChange={(e) => onProvider(e.target.value as AgentProviderId)}>
            {PROVIDER_LIST.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Working directory
          <div className="row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~/Developer/my-project"
              spellCheck={false}
            />
            <button type="button" onClick={pickFolder}>
              Browse…
            </button>
          </div>
        </label>

        <label>
          Command
          <input value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        </label>

        {AGENT_PROVIDERS[provider].supportsModel && (
          <label>
            Model <span className="hint">(optional)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="leave blank for the CLI default"
              spellCheck={false}
            />
          </label>
        )}

        <label>
          Name <span className="hint">(optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="defaults to the folder name"
          />
        </label>

        <label>
          Pokemon <span className="hint">(one per session)</span>
          <div className="pokemon-picker">
            {POKEMON_ROSTER.map((p) => {
              const isTaken = taken.has(p.name);
              return (
                <button
                  key={p.name}
                  type="button"
                  className={p.name === pokemon ? 'pokemon-option chosen' : 'pokemon-option'}
                  disabled={isTaken}
                  title={isTaken ? `${p.label} is already in the garden` : p.label}
                  onClick={() => setPokemon(p.name)}
                >
                  <PokemonFace name={p.name} />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
