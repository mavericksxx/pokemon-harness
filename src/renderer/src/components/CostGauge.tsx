/** "911k" / "1.0m" — the session-status strip/trainer-card's precise compact
 *  token count (session-status feature): no tilde, and a one-decimal "m"
 *  step once the count clears a million, matching the approved mockup's
 *  context numbers. (This file used to also export a `CostGauge` component
 *  and a tooltip-only `formatTokenCount` helper — a small context-usage bar
 *  FocusHeader.tsx rendered next to its status chip. That was a second,
 *  unlabeled copy of the exact same numbers SessionStatusStrip's labeled
 *  "context" bar already shows directly below it, so it was removed; this
 *  formatter is the only piece of the file still in use, by
 *  SessionStatusStrip.tsx/TrainerCard.tsx/ArceusRosterCard.tsx.) */
export function formatContextCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}
