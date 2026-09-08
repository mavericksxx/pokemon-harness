/** Terminal QoL settings store (Phase 8.5 Wave B item 3) — font size and
 *  scrollback depth, persisted to main (see terminalSettings.ts) on every
 *  change and applied live to every mounted terminal (terminalRegistry.ts's
 *  `applyTerminalSettings`). Separate from `@/store/store.ts` for the same
 *  reason `audioStore.ts` is separate — no overlap with session state. */
import { create } from 'zustand';
import { clampTerminalSettings, DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '@shared/terminalTypes';
import { applyTerminalSettings } from '@/pty/terminalRegistry';

interface SetSettingOptions {
  /** Default true. `false` (a slider drag tick — SettingsPanel.tsx) collapses
   *  the persist IPC + per-terminal `applyTerminalSettings` call (which fits
   *  and SIGWINCHes every live terminal via resizePty) into one trailing
   *  debounce instead of firing on every tick — see `commit` below. */
  persist?: boolean;
}

interface TerminalSettingsState {
  settings: TerminalSettings;
  loaded: boolean;
  hydrate(settings: TerminalSettings): void;
  setFontSize(px: number, options?: SetSettingOptions): void;
  setScrollback(lines: number, options?: SetSettingOptions): void;
}

function persist(settings: TerminalSettings): void {
  void window.api.saveTerminalSettings(settings);
}

/** Trailing debounce (single timer, shared by both setters — only the latest
 *  settings snapshot ever matters) for the persist IPC + `applyTerminalSettings`
 *  call. A fast slider drag used to fire both on every tick — persist IPC'd
 *  main on every pixel of movement, and applyTerminalSettings fit + resizePty
 *  (a SIGWINCH to every live terminal's PTY) just as often. */
const SETTINGS_COMMIT_DEBOUNCE_MS = 150;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

function commit(settings: TerminalSettings, persistNow: boolean): void {
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  if (persistNow) {
    persist(settings);
    applyTerminalSettings(settings);
    return;
  }
  commitTimer = setTimeout(() => {
    commitTimer = null;
    persist(settings);
    applyTerminalSettings(settings);
  }, SETTINGS_COMMIT_DEBOUNCE_MS);
}

export const useTerminalSettingsStore = create<TerminalSettingsState>((set, get) => ({
  settings: DEFAULT_TERMINAL_SETTINGS,
  loaded: false,

  hydrate: (settings) => {
    set({ settings, loaded: true });
    applyTerminalSettings(settings);
  },
  setFontSize: (px, options) => {
    const settings = clampTerminalSettings({ ...get().settings, fontSize: px });
    set({ settings });
    commit(settings, options?.persist ?? true);
  },
  setScrollback: (lines, options) => {
    const settings = clampTerminalSettings({ ...get().settings, scrollback: lines });
    set({ settings });
    commit(settings, options?.persist ?? true);
  }
}));
