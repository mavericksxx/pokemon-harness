import type { SessionCostUpdate } from '@shared/costTypes';

/** "~41k" — the cost gauge's compact token count. Under 1000 shown verbatim
 *  (no point abbreviating a 3-digit number). */
export function formatTokenCount(n: number): string {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `${n}`;
}

interface Props {
  cost: SessionCostUpdate;
  /** Outer positioned container's class — defaults to the roster card's own
   *  `.roster-card-gauge` (absolute, flush along the card's bottom edge).
   *  FocusHeader.tsx (BACKLOG phase E) passes `.focus-header-gauge` instead
   *  — same fill, a plain inline row rather than an absolute overlay. */
  className?: string;
}

/** Cost & context HUD (Phase 8.5 Wave B item 1) — the same per-session
 *  `cost` telemetry AgentRosterCard.tsx has always rendered, factored out so
 *  the focus-mode identity header (BACKLOG phase E) can show identical
 *  numbers without re-deriving them. Caller checks `session.cost` first
 *  (undefined is the gauge's own "don't render" signal, same as before). */
export function CostGauge({ cost, className }: Props): JSX.Element {
  const contextPct = Math.min(1, cost.contextTokens / cost.contextWindow);
  const tip = `${formatTokenCount(cost.contextTokens)} / ${formatTokenCount(cost.contextWindow)} context (approx.) · $${cost.costUsd.toFixed(2)}`;
  return (
    <div className={className ?? 'roster-card-gauge'} title={tip} aria-label={tip}>
      <div className="roster-card-gauge-fill" style={{ width: `${Math.round(contextPct * 100)}%` }} />
    </div>
  );
}
