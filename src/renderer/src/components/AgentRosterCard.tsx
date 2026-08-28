import { useState } from 'react';
import type { Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { PokemonPicker } from '@/components/PokemonPicker';
import { toolIcon } from '@/scene/garden/ToolBubble';
import { speciesEntry } from '@/scene/garden/dexData';
import { evolutionConfig } from '@/scene/garden/evolution';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { formatToolTarget } from '@/design/toolTargetLabel';
import { LoopIcon, SwapIcon } from '@/components/icons';
import { swapSessionPokemon } from '@/sessions';

/** Phase 8 §3 — one session as a roster card: sprite face, name, provider,
 *  status, current tool, an evolution progress hint, and a shiny star.
 *  Used both in the terminal-focus sidebar and the sessions overview grid. */
interface Props {
  session: Session;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** `undefined` when the session's current species has no further evolution
 *  reachable from here (already at its line's last stage) — the card omits
 *  the progress hint in that case rather than showing a permanently-full bar. */
function evolutionHint(session: Session): { pct: number; label: string } | undefined {
  const entry = speciesEntry(session.pokemon);
  if (!entry || entry.evolvesTo.length === 0) return undefined;
  const { stage2Ms, stage3Ms } = evolutionConfig();
  const threshold = entry.stage === 1 ? stage2Ms : entry.stage === 2 ? stage3Ms : undefined;
  if (!threshold) return undefined;
  return { pct: Math.min(1, session.workedMs / threshold), label: 'next evolution' };
}

/** "~41k" — the cost gauge's compact token count. Under 1000 shown verbatim
 *  (no point abbreviating a 3-digit number). */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `${n}`;
}

export function AgentRosterCard({ session, selected, onSelect }: Props): JSX.Element {
  // "Change pokemon" (roster card affordance) — not offered for Arceus, who
  // is fixed. Opens the same full-dex picker NewSessionDialog uses;
  // picking an option applies immediately (swapSessionPokemon) and closes.
  const [swapOpen, setSwapOpen] = useState(false);
  // "keep at this stage — don't evolve" (Phase C follow-up) — the swap
  // dialog's own checkbox state; re-synced to session.evolutionFrozen every
  // time the dialog opens (see the swap button's onClick below), not just on
  // this component's first mount.
  const [freezeStage, setFreezeStage] = useState(!!session.evolutionFrozen);
  const providerLabel = AGENT_PROVIDERS[session.provider]?.label ?? session.provider;
  const toolText = session.tool
    ? `${toolIcon(session.tool)} ${formatToolTarget(session.tool, session.toolTarget) || session.tool}`
    : session.status === 'blocked'
      ? 'waiting on you'
      : session.status === 'working'
        ? 'working…'
        : '';
  const hint = evolutionHint(session);
  // Cost & context HUD (Phase 8.5 Wave B item 1) — undefined for a
  // non-claude session (or a claude session whose transcript hasn't been
  // parsed yet), which is the gauge's own "don't render" signal.
  const cost = session.cost;
  const contextPct = cost ? Math.min(1, cost.contextTokens / cost.contextWindow) : 0;
  const gaugeTip = cost
    ? `${formatTokenCount(cost.contextTokens)} / ${formatTokenCount(cost.contextWindow)} context (approx.) · $${cost.costUsd.toFixed(2)}`
    : '';

  const classes = ['roster-card', selected && 'selected'].filter(Boolean).join(' ');

  return (
    // Wrapper, not the card `<button>` itself, owns the swap button and its
    // positioning context — a `<button>` can't nest another `<button>`, and
    // `.roster-card`'s own hover-lift transform must stay off this element
    // (a transformed ancestor becomes the containing block for a `position:
    // fixed` descendant, which would break the swap dialog's backdrop).
    // (Arceus never renders here — RosterStrip/SessionsOverview filter him
    // out; his one home is the topbar chip.)
    <div className="roster-card-wrap">
      <button
        className={classes}
        style={{ borderLeftColor: `#${session.accent.toString(16).padStart(6, '0')}` }}
        onClick={() => onSelect(session.id)}
        title={`${session.command} — ${session.cwd}`}
      >
        <div className="roster-card-top">
          <span className="roster-card-face">
            <PokemonFace name={session.pokemon} shiny={session.shiny} box={32} />
            {session.shiny && (
              <span className="shiny-badge roster-card-shiny" title="shiny" aria-label="shiny">
                ★
              </span>
            )}
          </span>
          <span className="roster-card-id">
            <span className="roster-card-name">{session.title}</span>
            <span className="roster-card-provider">{providerLabel}</span>
            {/* Phase C item 1: `entry.name` lowercased, not the raw dex id —
                ~42 species (Ho-Oh, Mr. Mime, Flabébé, Tapu Koko...) have a
                punctuation-stripped id that reads wrong on its own (hooh,
                mrmime). Reads off `session.pokemon` (same field PokemonFace/
                evolutionHint above use), so it updates on its own when the
                session evolves or gets swapped, no extra state. */}
            <span className="roster-card-species">
              {(speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase()}
            </span>
          </span>
          {/* Phase 8.5: `looping` and `napping` are flags orthogonal to
              `status` (see loopDetector.ts / sessionLabel.ts) — looping wins
              the label because it's the one that needs the user's eyes. */}
          <em className={session.napping ? 'status napping' : `status ${session.status}`}>
            {session.looping ? (
              <>
                <LoopIcon className="status-loop-icon" /> looping
              </>
            ) : (
              sessionStatusLabel(session)
            )}
          </em>
        </div>

        {toolText && <div className="roster-card-tool">{toolText}</div>}

        {hint && (
          <div className="roster-card-evo" title={hint.label}>
            <div className="roster-card-evo-fill" style={{ width: `${Math.round(hint.pct * 100)}%` }} />
          </div>
        )}

        {cost && (
          <div className="roster-card-gauge" title={gaugeTip} aria-label={gaugeTip}>
            <div className="roster-card-gauge-fill" style={{ width: `${Math.round(contextPct * 100)}%` }} />
          </div>
        )}
      </button>

      {/* Phase C item 2: was an 18x18 icon-only corner badge users couldn't
          find/hit (screenshot complaint) — now a labeled pill hover-revealed
          at the card's bottom-right, sized like the rest of the app's real
          controls rather than a tiny overlay glyph. */}
      <button
        type="button"
        className="roster-card-swap"
        onClick={() => {
          // Re-sync every time the dialog opens, not just on mount — the
          // checkbox below must reflect this session's CURRENT frozen state
          // even if it was left unchecked on a previous open-then-cancel.
          setFreezeStage(!!session.evolutionFrozen);
          setSwapOpen(true);
        }}
      >
        <SwapIcon />
        change pokemon
      </button>

      {swapOpen && (
        <div className="modal-backdrop" onClick={() => setSwapOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>change pokemon</h2>
            {/* Phase C follow-up: change-pokemon stage semantics — freezes
                evolution at whatever species gets picked below. Reachable
                and reversible through this same dialog (pre-checked to the
                session's current `evolutionFrozen`, synced on open above).
                Commits together with the species pick (there's no separate
                save step) — picking the session's OWN current species below
                is a valid pick (swapSessionPokemon rebases its clock too),
                so that's how this applies on its own. */}
            <label className="pokemon-swap-freeze">
              <input
                type="checkbox"
                checked={freezeStage}
                onChange={(e) => setFreezeStage(e.target.checked)}
              />
              keep at this stage — don't evolve
            </label>
            <p className="hint pokemon-note">
              picking a species below applies it — pick the current one to change just this.
            </p>
            <PokemonPicker
              value={session.pokemon}
              excludeSessionId={session.id}
              onChange={(id) => {
                swapSessionPokemon(session.id, id, freezeStage);
                setSwapOpen(false);
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setSwapOpen(false)}>
                cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
