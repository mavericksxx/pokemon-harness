import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { baseStageOf, DEX_LIST, formsOf, searchDex, speciesEntry, type DexEntry } from '@/scene/garden/dexData';
import { PokemonFace } from './PokemonFace';

interface Props {
  /** Currently-highlighted species id (rendered `.chosen`). */
  value: string;
  onChange(id: string): void;
  /** A session id whose own line should NOT count as "taken" — the swap
   *  dialog's session is already wearing this line, so it shouldn't grey
   *  itself out. Omitted for creation, where every live session's line is
   *  off-limits. */
  excludeSessionId?: string;
}

/**
 * Full-dex search-and-pick grid — shared by NewSessionDialog (extracted from
 * there) and the roster card's "change pokemon" swap dialog. Empty query
 * browses the FULL ~1025-species dex, in dex-number order; a non-empty query
 * type-aheads by name or dex number (`searchDex`, capped at 30 results —
 * unchanged from before).
 *
 * Browsing the full dex means most on-screen options are unbundled — each
 * would otherwise fire a real thumbnail fetch (frame-0-only decode; still
 * the OOM-fix path — see PokemonFace/lazySprites) the instant it mounts, so
 * an IntersectionObserver gates each option's `PokemonFace` behind actually
 * scrolling it into the grid's own viewport (`root`), not just being in the
 * DOM. `rootMargin` primes a little ahead of the visible area; once an id
 * has been shown it stays shown (scrolling back up doesn't re-hide/re-fetch
 * it — `loadLazyThumbnail`'s own cache would no-op a re-fetch anyway, this
 * just avoids the pop-out). Options not yet shown render the same
 * `.pokemon-face.loading` placeholder `PokemonFace` itself uses while ITS
 * fetch is pending, so there's one consistent "still loading" look rather
 * than a distinct stuck-looking ghost.
 */
export function PokemonPicker({ value, onChange, excludeSessionId }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const takenLines = new Set(
    sessions.filter((s) => s.id !== excludeSessionId).map((s) => s.line)
  );
  const [query, setQuery] = useState('');
  // Debounced: every intermediate keystroke's result set would otherwise mount
  // a PokemonFace per unbundled result, each firing a real GIF fetch — typing
  // "gengar" would fetch every species matching "g", "ge", "gen"... on the way.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const results: readonly DexEntry[] = debouncedQuery.trim() ? searchDex(debouncedQuery, 30) : DEX_LIST;

  // Alt-battle-form sub-panel (e.g. Zacian's Crowned Sword form) — the base
  // species id currently showing its form options below the grid, or null.
  // Re-derived from `value` on mount and every time it changes (not just
  // once) so reopening the swap dialog on a session already wearing a form
  // lands on the right sub-panel with no extra click — `value`'s relevant
  // base is either its own baseSpecies (if it's itself a form) or itself (if
  // it's a base species that happens to have forms).
  const [formsPickerFor, setFormsPickerFor] = useState<string | null>(null);
  useEffect(() => {
    const relevantBase = speciesEntry(value)?.baseSpecies ?? value;
    setFormsPickerFor(formsOf(relevantBase).length > 0 ? relevantBase : null);
  }, [value]);

  const gridRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const newlyVisible = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.pokeId);
        if (newlyVisible.length === 0) return;
        setShown((prev) => {
          const next = new Set(prev);
          for (const id of newlyVisible) if (id) next.add(id);
          // Same size means every "newly visible" id was already shown (the
          // observer's initial callback re-reports everything currently
          // intersecting, not just genuinely new ones) — returning `prev`
          // here is what makes React skip the re-render. Without it: a
          // no-op update still re-renders, `searchDex`'s RESULT array is
          // rebuilt fresh (unlike DEX_LIST's stable reference), the effect
          // below sees a changed dependency and re-observes, the observer's
          // initial callback fires again — an infinite loop the whole time
          // the search box has text.
          return next.size === prev.size ? prev : next;
        });
      },
      { root: grid, rootMargin: '200px 0px' }
    );
    for (const el of grid.querySelectorAll<HTMLElement>('[data-poke-id]')) observer.observe(el);
    return () => observer.disconnect();
  }, [results]);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search all 1025 by name or dex number…"
        spellCheck={false}
      />
      <div className="pokemon-picker" ref={gridRef}>
        {results.map((entry) => {
          const entryBase = baseStageOf(entry.id);
          const isTaken = takenLines.has(entryBase.line);
          // The picker doesn't show a shiny sprite for a taken option
          // (disabled options render grayscaled — see .pokemon-option:
          // disabled — so the palette difference wouldn't even show); it
          // just flags that the line currently out in the garden happens to
          // be shiny.
          const takenByShiny = isTaken && sessions.some((s) => s.line === entryBase.line && s.shiny);
          // hasSprite: false means the builder's coverage sweep confirmed
          // the Smogon Sprite Project has no art for this species (Phase 6
          // §2) — grey it out rather than let a pick fail at fetch time.
          const noSprite = entry.hasSprite === false;
          const disabled = isTaken || noSprite;
          const optionTitle = noSprite
            ? `no sprite available for ${entry.name}`
            : isTaken
              ? `${entry.name}'s line is already in the garden`
              : entry.name;
          return (
            <button
              key={entry.id}
              type="button"
              data-poke-id={entry.id}
              className={entry.id === value ? 'pokemon-option chosen' : 'pokemon-option'}
              disabled={disabled}
              title={optionTitle}
              onClick={() => {
                // A species with alt forms doesn't commit yet — reveal the
                // form sub-panel below instead, same as the effect above
                // does when the dialog opens on one. `onChange` only ever
                // fires once the user has picked a final (base-or-form) id,
                // matching both callers' "onChange commits" assumption.
                const forms = formsOf(entry.id);
                if (forms.length > 0) setFormsPickerFor(entry.id);
                else onChange(entry.id);
              }}
            >
              <span className="pokemon-option-face">
                {noSprite || !shown.has(entry.id) ? (
                  // No `box` prop here (unlike PokemonFace's own loading
                  // state) — sized explicitly to match the enlarged 72px
                  // slot below, since `.pokemon-face` itself carries no
                  // default width/height.
                  <i className="pokemon-face loading" style={{ width: 72, height: 72 }} aria-hidden />
                ) : (
                  // Phase C item 3: bigger thumbnail (was the 44px default) —
                  // `.pokemon-option-face` below is sized to match.
                  <PokemonFace name={entry.id} box={72} />
                )}
              </span>
              <span className="pokemon-option-name">{entry.name}</span>
              {takenByShiny && (
                <span className="shiny-badge" title="a shiny is out in the garden" aria-label="shiny">
                  ★
                </span>
              )}
              {entry.static && <em className="pokemon-static-tag">static sprite</em>}
            </button>
          );
        })}
        {debouncedQuery.trim() && results.length === 0 && <p className="hint">no match.</p>}
      </div>
      {formsPickerFor &&
        (() => {
          const baseEntry = speciesEntry(formsPickerFor);
          if (!baseEntry) return null;
          // Base species first, then every alt form — clicking any of these
          // is the only place this sub-panel ever calls `onChange`.
          const options: DexEntry[] = [baseEntry, ...formsOf(formsPickerFor)];
          const namePrefix = `${baseEntry.name}-`;
          return (
            <div className="pokemon-forms-panel">
              <p className="pokemon-forms-heading">{baseEntry.name} — choose a form</p>
              <div className="pokemon-forms-grid">
                {options.map((opt) => {
                  const label = opt.name.startsWith(namePrefix) ? opt.name.slice(namePrefix.length) : opt.name;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={opt.id === value ? 'pokemon-form-option chosen' : 'pokemon-form-option'}
                      title={opt.name}
                      onClick={() => onChange(opt.id)}
                    >
                      <PokemonFace name={opt.id} box={56} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
    </>
  );
}
