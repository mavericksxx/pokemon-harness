/** Terminal colors shared by xterm and detached PTYs so their replies agree. */
export const TERMINAL_COLORS = {
  dark: { foreground: '#DEDBD6', background: '#1A1A1F' },
  light: { foreground: '#1A1320', background: '#FCFAF0' }
} as const;
