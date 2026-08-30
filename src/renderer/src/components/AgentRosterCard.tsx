import { useState } from 'react';
import { useStore, type Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { PokemonPicker } from '@/components/PokemonPicker';
import { toolIcon } from '@/scene/garden/ToolBubble';
import { speciesEntry } from '@/scene/garden/dexData';
import { evolutionConfig } from '@/scene/garden/evolution';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { formatToolTarget } from '@/design/toolTargetLabel';
import { LoopIcon, PokeballIcon, SwapIcon } from '@/components/icons';
import { ModelBadge } from '@/components/ModelBadge';
import { TrainerCard } from '@/components/TrainerCard';
import { gaugeTone } from '@/design/gaugeTone';
import { swapSessionPokemon } from '@/sessions';

/** Phase 8 §3 — one session as a roster card: sprite face, name, provider,
 *  status, current tool, an evolution progress hint, and a shiny star.
 *  Used both in the terminal-focus sidebar and the sessions overview grid. */
interface Props {
  session: Session;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Garden-split roster-strip rework — a card's SIZE, not a different
   *  component: FocusSidebar's vertical list and SessionsOverview's grid
   *  never pass this (default 'full', today's card unchanged, every row
   *  intact). RosterStrip.tsx is the only caller that ever passes
   *  'compact'/'medium' — 'compact' for every unselected card (sprite,
   *  truncated title, status dot, thin context sliver — nothing else),
   *  'medium' for the currently selected one (adds a "provider · species"
   *  line and a model-badge/context row, but deliberately NOT the live tool
   *  line or the "working…" status pill — user decision, see BACKLOG). */
  variant?: 'full' | 'compact' | 'medium';
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

export function AgentRosterCard({ session, selected, onSelect, variant = 'full' }: Props): JSX.Element {
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
  const providerShortLabel = AGENT_PROVIDERS[session.provider]?.shortLabel ?? session.provider;
  // First-class delegate sessions (shared/delegateSpawn.ts) — a "↳ <parent>"
  // link, same affordance SubagentRosterCard.tsx already uses for a battler.
  // Resolved here (rather than threaded through as a prop from every one of
  // this card's three call sites) since only the id is stored on the
  // session record itself.
  const delegateParentTitle = useStore((s) =>
    session.delegateParentId ? s.sessions.find((p) => p.id === session.delegateParentId)?.title : undefined
  );
  const requestRecallDelegate = useStore((s) => s.requestRecallDelegate);
  const speciesLower = (speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase();
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
  // Session-status feature — the context row's HP-bar percent/tone, computed
  // once here rather than inside the JSX below.
  const contextPct = cost ? Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100) : 0;
  const contextTone = gaugeTone(contextPct);

  const classes = ['roster-card', variant !== 'full' && `roster-card-${variant}`, selected && 'selected']
    .filter(Boolean)
    .join(' ');
  // Width lives on the WRAP (`.roster-strip .roster-card-wrap` below), not
  // the button — 'compact' is that selector's own default (every unselected
  // strip card), so only 'medium' needs an override class here. 'full'
  // (FocusSidebar/SessionsOverview) never mounts inside `.roster-strip` at
  // all, so neither class ever applies there — same DOM as before this prop
  // existed.
  const wrapClasses = ['roster-card-wrap', variant === 'medium' && 'roster-card-wrap-medium']
    .filter(Boolean)
    .join(' ');

  return (
    // Wrapper, not the card `<button>` itself, owns the swap button and its
    // positioning context — a `<button>` can't nest another `<button>`, and
    // `.roster-card`'s own hover-lift transform must stay off this element
    // (a transformed ancestor becomes the containing block for a `position:
    // fixed` descendant, which would break the swap dialog's backdrop).
    // (Arceus never renders here — RosterStrip/SessionsOverview filter him
    // out; his one home is the topbar chip.)
    <div className={wrapClasses}>
      <button
        className={classes}
        style={{ borderLeftColor: `#${session.accent.toString(16).padStart(6, '0')}` }}
        onClick={() => onSelect(session.id)}
        title={
          delegateParentTitle
            ? `${session.command} — ${session.cwd} — delegate of ${delegateParentTitle}`
            : `${session.command} — ${session.cwd}`
        }
      >
        {variant === 'compact' && (
          <>
            {/* Compact strip card (garden-split roster-strip rework) —
                sprite, truncated title, provider tag, a status dot, and a
                thin context sliver. Delegate sessions add their parent line
                while staying inside the fixed strip band. */}
            <div className="roster-card-top-compact">
              <span className="roster-card-face">
                <PokemonFace name={session.pokemon} shiny={session.shiny} box={18} />
                {session.shiny && (
                  <span className="shiny-badge roster-card-shiny" title="shiny" aria-label="shiny">
                    ★
                  </span>
                )}
              </span>
              <span className="roster-card-title-compact">{session.title}</span>
              <span className="roster-card-provider-compact">{providerShortLabel}</span>
              <span
                className={session.napping ? 'roster-card-dot napping' : `roster-card-dot ${session.status}`}
                aria-hidden="true"
              />
            </div>
            {delegateParentTitle && <div className="roster-card-parent-compact">↳ {delegateParentTitle}</div>}
            <div className="hp-bar roster-card-ctx-sliver">
              <div
                className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
                style={{ width: `${cost ? contextPct : 0}%` }}
              />
            </div>
          </>
        )}

        {variant === 'medium' && (
          <>
            {/* Medium strip card (selection expands, garden-split rework) —
                the approved hybrid: three rows, deliberately NOT the old
                full card below. Row 1 sprite+name+dot; row 2 one muted
                "provider · species" line; row 3 model badge + a smaller
                context bar + N%. The live tool line and the "working…" pill
                are excluded (user decision) — the terminal panel's own head
                already names the selected session and streams its live
                activity right next to this strip, so this card doesn't need
                to repeat either. */}
            <div className="roster-card-top-compact">
              <span className="roster-card-face">
                <PokemonFace name={session.pokemon} shiny={session.shiny} box={32} />
                {session.shiny && (
                  <span className="shiny-badge roster-card-shiny" title="shiny" aria-label="shiny">
                    ★
                  </span>
                )}
              </span>
              <span className="roster-card-title-compact">{session.title}</span>
              <span
                className={session.napping ? 'roster-card-dot napping' : `roster-card-dot ${session.status}`}
                aria-hidden="true"
              />
            </div>
            <div className="roster-card-meta-line">
              {providerLabel} · {(speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase()}
            </div>
            {delegateParentTitle && <div className="roster-card-parent-compact">↳ {delegateParentTitle}</div>}
            {/* Same height-jitter discipline as the full card below — this
                row is always mounted, badge/bar/label individually masked
                via `roster-card-row-hidden` (visibility, not display) until
                their own data arrives, so late telemetry fills reserved
                space instead of growing the card. */}
            <div className="roster-card-row3-medium">
              {cost?.model ? (
                <ModelBadge model={cost.model} changedFrom={session.modelChangedFrom} />
              ) : (
                <span className="model-badge roster-card-row-hidden">&nbsp;</span>
              )}
              <div
                className={
                  cost ? 'hp-bar roster-card-ctx-sliver-md' : 'hp-bar roster-card-ctx-sliver-md roster-card-row-hidden'
                }
              >
                <div
                  className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
                  style={{ width: `${cost ? contextPct : 0}%` }}
                />
              </div>
              <span className={cost ? 'roster-card-ctx-label' : 'roster-card-ctx-label roster-card-row-hidden'}>
                {cost ? `${contextPct}%` : ' '}
              </span>
            </div>
          </>
        )}

        {variant === 'full' && (
          <>
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
                  {/* First-class delegate sessions — "↳ <parent>" appended,
                      same shape SubagentRosterCard.tsx uses for a battler
                      (`${speciesName} · ↳ ${parent.title}`). */}
                  {delegateParentTitle ? `${speciesLower} · ↳ ${delegateParentTitle}` : speciesLower}
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

            {/* Strip height jitter fix (parity sweep item 1) — every row below is
                now ALWAYS mounted (never conditionally omitted), so a card's own
                natural height is fixed from its very first render instead of
                growing/shrinking as `toolText`/`hint`/`cost` arrive or clear
                later. `.roster-card-row-hidden` (index.css) just hides the
                content via `visibility: hidden`, which keeps the row's layout
                box (and therefore the card's height) exactly as if it were
                populated — the whole point being that late data FILLS reserved
                space instead of ADDING new space, which is what was reflowing
                the strip (`.roster-strip`'s `align-items: stretch` re-stretches
                every card to match whichever one just grew). */}
            <div className={toolText ? 'roster-card-tool' : 'roster-card-tool roster-card-row-hidden'}>
              {toolText || ' '}
            </div>

            <div className={hint ? 'roster-card-evo' : 'roster-card-evo roster-card-row-hidden'} title={hint?.label}>
              <div className="roster-card-evo-fill" style={{ width: `${hint ? Math.round(hint.pct * 100) : 0}%` }} />
            </div>

            <div className={cost?.model ? 'roster-card-badges' : 'roster-card-badges roster-card-row-hidden'}>
              {cost?.model ? (
                <ModelBadge model={cost.model} changedFrom={session.modelChangedFrom} />
              ) : (
                // Placeholder sized exactly like a real ModelBadge (same class,
                // same font/padding/border) so the row reserves the badge's own
                // height rather than collapsing to 0 with no child at all.
                <span className="model-badge">&nbsp;</span>
              )}
            </div>

            <div className={cost ? 'roster-card-ctx-row' : 'roster-card-ctx-row roster-card-row-hidden'}>
              <span className="roster-card-ctx-label">context</span>
              <div className="hp-bar">
                <div
                  className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
                  style={{ width: `${cost ? contextPct : 0}%` }}
                />
              </div>
              <span className="roster-card-ctx-label">{cost ? `${contextPct}%` : ' '}</span>
            </div>
          </>
        )}
      </button>

      {/* Trainer-card popover trigger (session-status feature) — a sibling of
          the card `<button>` above, same reasoning as `.roster-card-swap`
          below (a button can't nest another button); TrainerCard.tsx owns
          its own stopPropagation so opening it never also selects the card. */}
      <TrainerCard session={session} />

      {/* Phase C item 2: was an 18x18 icon-only corner badge users couldn't
          find/hit (screenshot complaint) — now a labeled pill hover-revealed
          at the card's bottom-right, sized like the rest of the app's real
          controls rather than a tiny overlay glyph. */}
      {!(session.delegateParentId && session.status === 'done') && (
        <button
          type="button"
          className="roster-card-swap"
          // Compact strip cards shrink this to an icon-only square (font-size:
          // 0 on the button, index.css) so the label doesn't spill past the
          // card's edge — `title` keeps "change pokemon" reachable as a hover
          // tooltip there instead of gone outright (the medium/full pill still
          // shows it inline as before).
          title="change pokemon"
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
      )}

      {/* First-class delegate cleanup — unlike a live delegate's kill action,
          this waits for the garden Walker's shared pokéball recall animation
          before the session is removed. */}
      {session.delegateParentId && session.status === 'done' && (
        <button
          type="button"
          className="roster-card-despawn"
          title="despawn delegate"
          onClick={() => requestRecallDelegate(session.id)}
        >
          <PokeballIcon />
          despawn
        </button>
      )}

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
