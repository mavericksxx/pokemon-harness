/** Types shared between main, preload and renderer for terminal QoL settings
 *  (Phase 8.5 Wave B item 3). Dependency-free, matching audioTypes.ts's
 *  pattern — same userData-JSON persistence shape (see
 *  src/main/terminalSettings.ts), just two scalars instead of five. */

export interface TerminalSettings {
  /** xterm `fontSize`, px. Clamped 10-18 (spec range) wherever it's set. */
  fontSize: number;
  /** xterm `scrollback`, lines. Clamped 1000-50000 (spec range). */
  scrollback: number;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 12, // first-run default only — loadTerminalSettings (main/terminalSettings.ts)
  // merges this UNDER whatever's already persisted, so an existing user's explicit choice
  // (even the prior 14px default, once saved) is never overwritten.
  scrollback: 30000 // raised from 5000. xterm stores each scrollback line as a fixed-size
  // typed array sized to the terminal's column count (not its text length), so cost is
  // ~cols * 12 bytes/line — at a typical ~120 cols that's ~1.4KB/line, ~42MB for 30k lines.
  // terminalRegistry.ts keeps one Terminal (and its full buffer) alive per session even
  // when not the attached/visible one, so this multiplies by however many sessions are
  // open at once — 30k (the low end of the requested 30-50k range, not 50k) keeps that
  // multi-session cost modest while still 6x the old default.
};

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 18;
export const TERMINAL_SCROLLBACK_MIN = 1000;
export const TERMINAL_SCROLLBACK_MAX = 50000;

export function clampTerminalSettings(s: TerminalSettings): TerminalSettings {
  return {
    fontSize: Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(s.fontSize))),
    scrollback: Math.min(TERMINAL_SCROLLBACK_MAX, Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(s.scrollback)))
  };
}
