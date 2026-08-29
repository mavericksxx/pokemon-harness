/** "resets in"/"as of" readouts for a usage window — extracted from
 *  UsageChip.tsx so TrainerCard.tsx's per-session popover (session-status
 *  feature) renders the account-level reset/freshness copy identically
 *  rather than inventing a second phrasing for the same numbers. */

/** Humanized "resets in" — under 1h → "Xm", under 24h → "Xh Ym", 24h+ →
 *  "Xd Yh" (user feedback: raw "resets in 93h 26m" / "resets in 416h 57m"
 *  reads as a bug, not a duration). */
export function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const diffMs = resetsAt - now;
  if (diffMs <= 0) return 'resets soon';
  const totalMin = Math.round(diffMs / 60_000);
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 1) return `resets in ${totalMin}m`;
  if (totalHours < 24) return `resets in ${totalHours}h ${totalMin % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `resets in ${days}d ${totalHours % 24}h`;
}

export function formatAgo(updatedAt: number | undefined, now: number): string {
  if (!updatedAt) return '';
  const diffMin = Math.max(0, Math.round((now - updatedAt) / 60_000));
  return diffMin <= 0 ? 'as of just now' : `as of ${diffMin}m ago`;
}
