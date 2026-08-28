import type { Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { toolIcon } from '@/scene/garden/ToolBubble';
import { speciesEntry } from '@/scene/garden/dexData';
import { evolutionConfig } from '@/scene/garden/evolution';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { LoopIcon } from '@/components/icons';

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
  const providerLabel = AGENT_PROVIDERS[session.provider]?.label ?? session.provider;
  // Alpha card (Phase 8.8 §5) — distinct treatment for Arceus: an "alpha"
  // tag (the games' own name for him — the ALPHA Pokémon) and his
  // ring-cycle color as the card's left accent border (instead of
  // `session.accent`, the ordinary per-session tint) via the `.alpha` CSS
  // class (index.css's `arceus-ring-cycle` keyframes). Everything else on
  // the card — status label, tool text, cost gauge — renders exactly as it
  // would for any other session; he's a real claude session, so gauges
  // apply the same as anyone's.
  const isArceus = !!session.isArceus;
  const toolText = session.tool
    ? `${toolIcon(session.tool)} ${session.toolTarget || session.tool}`
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

  const classes = ['roster-card', selected && 'selected', isArceus && 'alpha'].filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      // The alpha card's left border is CSS-animated (arceus-ring-cycle) —
      // an inline style here would win the cascade and freeze it.
      style={isArceus ? undefined : { borderLeftColor: `#${session.accent.toString(16).padStart(6, '0')}` }}
      onClick={() => onSelect(session.id)}
      title={`${session.command} — ${session.cwd}`}
    >
      <div className="roster-card-top">
        <span className="roster-card-face">
          <PokemonFace name={session.pokemon} shiny={session.shiny} box={32} />
          {session.shiny && (
            <span className="shiny-badge roster-card-shiny" title="Shiny" aria-label="shiny">
              ★
            </span>
          )}
        </span>
        <span className="roster-card-id">
          <span className="roster-card-name">
            {session.title}
            {isArceus && <span className="roster-card-alpha-tag">alpha</span>}
          </span>
          <span className="roster-card-provider">{providerLabel}</span>
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
  );
}
