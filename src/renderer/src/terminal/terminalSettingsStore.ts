/** Terminal QoL settings store (Phase 8.5 Wave B item 3) — font size and
 *  scrollback depth, persisted to main (see terminalSettings.ts) on every
 *  change and applied live to every mounted terminal (terminalRegistry.ts's
 *  `applyTerminalSettings`). Separate from `@/store/store.ts` for the same
 *  reason `audioStore.ts` is separate — no overlap with session state. */
import { create } from 'zustand';
import { clampTerminalSettings, DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '@shared/terminalTypes';
import { applyTerminalSettings } from '@/pty/terminalRegistry';

interface TerminalSettingsState {
  settings: TerminalSettings;
  loaded: boolean;
  hydrate(settings: TerminalSettings): void;
  setFontSize(px: number): void;
  setScrollback(lines: number): void;
}

function persist(settings: TerminalSettings): void {
  void window.api.saveTerminalSettings(settings);
}

export const useTerminalSettingsStore = create<TerminalSettingsState>((set, get) => ({
  settings: DEFAULT_TERMINAL_SETTINGS,
  loaded: false,

  hydrate: (settings) => {
    set({ settings, loaded: true });
    applyTerminalSettings(settings);
  },
  setFontSize: (px) => {
    const settings = clampTerminalSettings({ ...get().settings, fontSize: px });
    set({ settings });
    persist(settings);
    applyTerminalSettings(settings);
  },
  setScrollback: (lines) => {
    const settings = clampTerminalSettings({ ...get().settings, scrollback: lines });
    set({ settings });
    persist(settings);
    applyTerminalSettings(settings);
  }
}));
