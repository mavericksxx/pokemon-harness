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
  fontSize: 14, // matches design/tokens.ts's monoMd.size, the prior hardcoded value
  scrollback: 5000 // matches terminalRegistry.ts's prior hardcoded value
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
