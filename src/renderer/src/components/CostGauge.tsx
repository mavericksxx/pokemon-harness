import type { SessionCostUpdate } from '@shared/costTypes';

/** "~41k" — the cost gauge's compact token count. Under 1000 shown verbatim
 *  (no point abbreviating a 3-digit number). */
export function formatTokenCount(n: number): string {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `${n}`;
}

/** "911k" / "1.0m" — the session-status strip/trainer-card's precise compact
 *  token count (session-status feature). Distinct from `formatTokenCount`
 *  above (that one's tooltip-only "~41k" approximation stays as it is for
 *  its existing callers): no tilde, and a one-decimal "m" step once the
 *  count clears a million, matching the approved mockup's context numbers. */
export function formatContextCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

interface Props {
  cost: SessionCostUpdate;
  /** Outer positioned container's class — REQUIRED (session-status feature:
   *  AgentRosterCard.tsx no longer calls this component at all, so the old
   *  `?? 'roster-card-gauge'` default pointed at CSS that no longer exists;
   *  making this required keeps the JS and CSS from disagreeing again).
   *  FocusHeader.tsx (BACKLOG phase E) passes `.focus-header-gauge` — same
   *  fill, a plain inline row rather than an absolute overlay. */
  className: string;
}

/** Cost & context HUD (Phase 8.5 Wave B item 1) — the same per-session
 *  `cost` telemetry AgentRosterCard.tsx used to render before the
 *  session-status feature moved its context gauge to an in-flow HP-bar row
 *  (see index.css's `.roster-card-ctx-row`); factored out here so the
 *  focus-mode identity header (BACKLOG phase E) can show identical numbers
 *  without re-deriving them. Caller checks `session.cost` first (undefined
 *  is the gauge's own "don't render" signal, same as before). */
export function CostGauge({ cost, className }: Props): JSX.Element {
  const contextPct = Math.min(1, cost.contextTokens / cost.contextWindow);
  const tip = `${formatTokenCount(cost.contextTokens)} / ${formatTokenCount(cost.contextWindow)} context (approx.) · $${cost.costUsd.toFixed(2)}`;
  return (
    <div className={className} title={tip} aria-label={tip}>
      <div className="roster-card-gauge-fill" style={{ width: `${Math.round(contextPct * 100)}%` }} />
    </div>
  );
}
