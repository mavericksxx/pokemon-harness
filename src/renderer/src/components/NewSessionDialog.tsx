import { useEffect, useState } from 'react';
import { AGENT_PROVIDERS, DEFAULT_PROVIDER, PROVIDER_LIST, type AgentProviderId } from '@shared/agentProvider';
import { startSession } from '@/sessions';
import { useStore } from '@/store/store';
import { pickFreeLine, POKEMON_ROSTER } from '@/scene/garden/showdownArt';
import { baseStageOf, chainLabel, searchDex, speciesEntry, type DexEntry } from '@/scene/garden/dexData';
import { PokemonFace } from './PokemonFace';

interface Props {
  onClose(): void;
}

export function NewSessionDialog({ onClose }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const takenLines = new Set(sessions.map((s) => s.line));
  // Random default, chosen once on open from whichever bundled line is free.
  const [pokemon, setPokemon] = useState(() => pickFreeLine([...takenLines]).name);
  const [query, setQuery] = useState('');
  // Debounced: every intermediate keystroke's result set would otherwise mount
  // a PokemonFace per unbundled result, each firing a real GIF fetch — typing
  // "gengar" would fetch every species matching "g", "ge", "gen"... on the way.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);
  const [provider, setProvider] = useState<AgentProviderId>(DEFAULT_PROVIDER);
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState(AGENT_PROVIDERS[DEFAULT_PROVIDER].defaultCommand);
  const [model, setModel] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empty query: the bundled 42 need no network and cover most of the fun
  // evolution lines already, so they stay the default listing. Non-empty:
  // type-ahead over the full ~1025-species dex by name or dex number.
  const results: DexEntry[] = debouncedQuery.trim()
    ? searchDex(debouncedQuery, 30)
    : POKEMON_ROSTER.map((p) => speciesEntry(p.name)).filter((e): e is DexEntry => !!e);

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
    } else {
      setCommand(AGENT_PROVIDERS[id].defaultCommand);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!cwd.trim()) {
      setError('Choose a working directory.');
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
          Pokemon <span className="hint">(one per evolution line)</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all 1025 by name or dex number…"
            spellCheck={false}
          />
          <div className="pokemon-picker">
            {results.map((entry) => {
              const entryBase = baseStageOf(entry.id);
              const isTaken = takenLines.has(entryBase.line);
              // The picker doesn't show a shiny sprite for a taken option
              // (disabled options render grayscaled — see .pokemon-option:
              // disabled — so the palette difference wouldn't even show);
              // it just flags that the line currently out in the garden
              // happens to be shiny.
              const takenByShiny = isTaken && sessions.some((s) => s.line === entryBase.line && s.shiny);
              // hasSprite: false means the builder's coverage sweep confirmed
              // the Smogon Sprite Project has no art for this species (Phase
              // 6 §2) — grey it out rather than let a pick fail at fetch time.
              const noSprite = entry.hasSprite === false;
              const disabled = isTaken || noSprite;
              const optionTitle = noSprite
                ? `No sprite available for ${entry.name}`
                : isTaken
                  ? `${entry.name}'s line is already in the garden`
                  : entry.name;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === pokemon ? 'pokemon-option chosen' : 'pokemon-option'}
                  disabled={disabled}
                  title={optionTitle}
                  onClick={() => setPokemon(entry.id)}
                >
                  {noSprite ? (
                    <i className="pokemon-face loading" aria-hidden />
                  ) : (
                    <PokemonFace name={entry.id} />
                  )}
                  <span>{entry.name}</span>
                  {takenByShiny && (
                    <span className="shiny-badge" title="A shiny is out in the garden" aria-label="shiny">
                      ★
                    </span>
                  )}
                  {entry.static && <em className="pokemon-static-tag">static sprite</em>}
                </button>
              );
            })}
            {debouncedQuery.trim() && results.length === 0 && <p className="hint">No match.</p>}
          </div>
          <p className="hint pokemon-note">{note}</p>
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
