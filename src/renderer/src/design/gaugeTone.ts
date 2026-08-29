/** Pokémon-style HP-bar tone thresholds — shared by every pixel gauge in the
 *  app (the topbar usage chip/popover, the session-status statusline strip,
 *  the roster card's context row, and the trainer-card popover): <50% used
 *  reads as healthy (green), 50-79% is the caution band (amber), 80%+ is the
 *  danger band (red). Extracted from UsageChip.tsx (which originated these
 *  thresholds) so the session-status feature's new gauges never drift from
 *  the one the popover already ships. */
export type GaugeTone = 'normal' | 'warn' | 'danger';

export function gaugeTone(usedPercent: number): GaugeTone {
  if (usedPercent >= 80) return 'danger';
  if (usedPercent >= 50) return 'warn';
  return 'normal';
}
