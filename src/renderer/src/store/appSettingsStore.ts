/**
 * General app settings store (parity sweep): theme, per-provider auto-
 * permission mode, keep-awake, recent folders. Mirrors `audioStore.ts`'s
 * shape — persists the whole settings blob to main (userData JSON, see
 * `main/appSettings.ts`) on every change; five-ish small values, no
 * debouncing needed. Deliberately separate from `@/store/store.ts` (session/
 * garden state), same rationale audioStore.ts gives for its own separation.
 */
import { create } from 'zustand';
import type { AgentProviderId } from '@shared/agentProvider';
import { DEFAULT_APP_SETTINGS, MAX_RECENT_FOLDERS, type AppSettings, type ThemeMode } from '@shared/appSettingsTypes';

interface AppSettingsState {
  settings: AppSettings;
  loaded: boolean;

  hydrate(settings: AppSettings): void;
  setTheme(mode: ThemeMode): void;
  setAutoMode(provider: AgentProviderId, enabled: boolean): void;
  setKeepAwake(v: boolean): void;
  /** Pushes `path` to the front of the recent-folders list, deduping and
   *  capping at MAX_RECENT_FOLDERS — see sessions.ts's `startSession`. */
  addRecentFolder(path: string): void;
}

function persist(settings: AppSettings): void {
  void window.api.saveAppSettings(settings);
}

export const useAppSettingsStore = create<AppSettingsState>((set, get) => ({
  settings: DEFAULT_APP_SETTINGS,
  loaded: false,

  hydrate: (settings) => set({ settings, loaded: true }),

  setTheme: (mode) => {
    const settings = { ...get().settings, theme: mode };
    set({ settings });
    persist(settings);
  },

  setAutoMode: (provider, enabled) => {
    const settings = {
      ...get().settings,
      autoModeByProvider: { ...get().settings.autoModeByProvider, [provider]: enabled }
    };
    set({ settings });
    persist(settings);
  },

  setKeepAwake: (v) => {
    const settings = { ...get().settings, keepAwake: v };
    set({ settings });
    persist(settings);
  },

  addRecentFolder: (path) => {
    const deduped = [path, ...get().settings.recentFolders.filter((p) => p !== path)];
    const settings = { ...get().settings, recentFolders: deduped.slice(0, MAX_RECENT_FOLDERS) };
    set({ settings });
    persist(settings);
  }
}));
