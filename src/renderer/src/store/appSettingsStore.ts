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
import type { UsageProviderId } from '@shared/usageTypes';
import { applyTheme } from '@/design/tokens';
import { resolveEffectiveTheme } from '@/design/theme';
import { applyTerminalTheme } from '@/pty/terminalRegistry';

interface AppSettingsState {
  settings: AppSettings;
  loaded: boolean;
  /** The CURRENT resolved harness home directory (Phase 8.7) — an absolute
   *  path even while `settings.harnessHomeDir` is null (the default), since
   *  only main can resolve that (needs `os.homedir()`). Hydrated at boot and
   *  refreshed after every `setHarnessHomeDir` call. */
  harnessHomePath: string;

  hydrate(settings: AppSettings): void;
  hydrateHarnessHomePath(path: string): void;
  setTheme(mode: ThemeMode): void;
  setDefaultAgentProvider(provider: AgentProviderId): void;
  setAutoMode(provider: AgentProviderId, enabled: boolean): void;
  setKeepAwake(v: boolean): void;
setHideClaudeStatusline(v: boolean): void;
  /** BUG/UX fix opt-out — same persist-immediately pattern as every other
   *  setter here; main's `appSettings:saveSettings` handler reaches
   *  pty.ts's `setShellFallbackEnabled` off this value. */
  setShellFallbackEnabled(v: boolean): void;
  /** In-app provider usage-limits panel (BACKLOG "next up" item 1) — opt-in
   *  toggle, off by default. Persisted the same way every other field here
   *  is; main's `appSettings:saveSettings` handler is what actually starts/
   *  tears down usageService.ts's polling off this value. */
  setUsageLimitsEnabled(v: boolean): void;
  /** Per-provider include/exclude for the usage-limits panel (feedback:
   *  "let the user pick which providers to include"). Same persist-
   *  immediately pattern as `setUsageLimitsEnabled` above; main's
   *  `appSettings:saveSettings` handler is what actually reaches
   *  usageService.ts's `setExcludedProviders` off this value. */
  setUsageProviderEnabled(provider: UsageProviderId, enabled: boolean): void;
  /** Which provider's numbers the topbar chip/trainer-card show by default
   *  (settings' usage section). Same persist-immediately pattern as
   *  `setUsageLimitsEnabled` above; display-only, no main-side reach. */
  setMainUsageProvider(provider: UsageProviderId | 'auto'): void;
  /** Diagnostics opt-in (BACKLOG friend-testing readiness) — same
   *  persist-immediately pattern as every other setter here; main's
   *  `appSettings:saveSettings` handler reaches
   *  diagnostics.ts's `setDiagnosticsLoggingEnabled` off this value. */
  setDiagnosticsLoggingEnabled(v: boolean): void;
  /** Render-resolution experiment (settings → diagnostics) — same persist-
   *  immediately pattern as every other setter here. The resolution GardenScene
   *  actually inits Pixi with only changes on next scene rebuild/app restart
   *  (see GardenScene.tsx's own comment), but the `image-rendering: pixelated`
   *  CSS this also drives is applied live right away — harmless before that
   *  rebuild (nothing to pixelate yet at the old resolution) and correct
   *  immediately after it. */
  setLowResGarden(v: boolean): void;
  /** Harness-owned instructions file (HARNESS.md) toggle — same
   *  persist-immediately pattern as every other setter here; main's
   *  `appSettings:saveSettings` handler reaches pty.ts's
   *  `setHarnessInstructions` off this value. */
  setHarnessInstructionsEnabled(v: boolean): void;
  /** Which model/alias the bundled advisor subagent runs on (settings →
   *  harness home). Same persist-immediately pattern as every other setter
   *  here; main's `appSettings:saveSettings` handler reaches pty.ts's
   *  `setAdvisorModel` off this value. */
  setAdvisorModel(v: string): void;
  /** Optional model override for a `poke-delegate` (Codex) spawn (settings →
   *  harness home). Empty string means "don't pass `-m`, inherit Codex's own
   *  configured default." Same persist-immediately pattern as every other
   *  setter here. */
  setCodexDelegateModel(v: string): void;
  /** First-launch welcome dialog (BACKLOG item 2) — same persist-immediately
   *  pattern as every other setter here. Set once, by either of the
   *  welcome dialog's two buttons (WelcomeDialog.tsx) — never reset from
   *  inside the app; a user who wants to see it again would have to edit
   *  app-settings.json by hand, same reach as `harnessHomeDir`. */
  setOnboardingDone(v: boolean): void;
  /** Pushes `path` to the front of the recent-folders list, deduping and
   *  capping at MAX_RECENT_FOLDERS — see sessions.ts's `startSession`. */
  addRecentFolder(path: string): void;
  /** `dir` null resets to the default (`~/PokemonHarness`) — see
   *  appSettingsTypes.ts's `harnessHomeDir` field comment for what changing
   *  this does and doesn't do. */
  setHarnessHomeDir(dir: string | null): void;
}

// Render-resolution experiment's CSS hook: `.garden canvas`'s `image-rendering`
// (index.css) keys off this body class rather than anything in GardenScene.tsx
// itself, so toggling it stays live-reactive even though the setting it mirrors
// only actually changes Pixi's resolution on next scene rebuild — see
// GardenScene.tsx's own comment at the `resolution:` line.
function applyLowResGardenClass(enabled: boolean): void {
  document.body.classList.toggle('garden-lowres', enabled);
}

function persist(settings: AppSettings): void {
  // saveAppSettings resolves to the (possibly just-changed) harness home
  // directory — see main/index.ts's `appSettings:saveSettings` handler.
  void window.api.saveAppSettings(settings).then((path) => {
    useAppSettingsStore.getState().hydrateHarnessHomePath(path);
  });
}

export const useAppSettingsStore = create<AppSettingsState>((set, get) => ({
  settings: DEFAULT_APP_SETTINGS,
  loaded: false,
  harnessHomePath: '',

  hydrate: (settings) => {
    set({ settings, loaded: true });
    applyLowResGardenClass(settings.lowResGarden);
  },
  hydrateHarnessHomePath: (path) => set({ harnessHomePath: path }),

  setTheme: (mode) => {
    const settings = { ...get().settings, theme: mode };
    set({ settings });
    persist(settings);
    // Applied here (not left to each caller) so every setTheme call site —
    // the settings panel's picker, the topbar quick toggle — recolors the
    // chrome AND every open terminal live, with one place owning that
    // pairing. Same pattern terminalSettingsStore.ts's own setters use for
    // applyTerminalSettings.
    const effective = resolveEffectiveTheme(mode);
    applyTheme(effective);
    applyTerminalTheme(effective);
  },

  setDefaultAgentProvider: (provider) => {
    const settings = { ...get().settings, defaultAgentProvider: provider };
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

setHideClaudeStatusline: (v) => {
    const settings = { ...get().settings, hideClaudeStatusline: v };
    set({ settings });
    persist(settings);
  },

  setShellFallbackEnabled: (v) => {
    const settings = { ...get().settings, shellFallbackEnabled: v };
    set({ settings });
    persist(settings);
  },

  setUsageLimitsEnabled: (v) => {
    const settings = { ...get().settings, usageLimitsEnabled: v };
    set({ settings });
    persist(settings);
  },

  setUsageProviderEnabled: (provider, enabled) => {
    const current = get().settings.usageExcludedProviders;
    const usageExcludedProviders = enabled
      ? current.filter((p) => p !== provider)
      : current.includes(provider)
        ? current
        : [...current, provider];
    const settings = { ...get().settings, usageExcludedProviders };
    set({ settings });
    persist(settings);
  },

  setMainUsageProvider: (provider) => {
    const settings = { ...get().settings, mainUsageProvider: provider };
    set({ settings });
    persist(settings);
  },

  setDiagnosticsLoggingEnabled: (v) => {
    const settings = { ...get().settings, diagnosticsLoggingEnabled: v };
    set({ settings });
    persist(settings);
  },

  setLowResGarden: (v) => {
    const settings = { ...get().settings, lowResGarden: v };
    set({ settings });
    persist(settings);
    applyLowResGardenClass(v);
  },

  setHarnessInstructionsEnabled: (v) => {
    const settings = { ...get().settings, harnessInstructionsEnabled: v };
    set({ settings });
    persist(settings);
  },

  setAdvisorModel: (v) => {
    const settings = { ...get().settings, advisorModel: v };
    set({ settings });
    persist(settings);
  },

  setCodexDelegateModel: (v) => {
    const settings = { ...get().settings, codexDelegateModel: v };
    set({ settings });
    persist(settings);
  },

  setOnboardingDone: (v) => {
    const settings = { ...get().settings, onboardingDone: v };
    set({ settings });
    persist(settings);
  },

  addRecentFolder: (path) => {
    const deduped = [path, ...get().settings.recentFolders.filter((p) => p !== path)];
    const settings = { ...get().settings, recentFolders: deduped.slice(0, MAX_RECENT_FOLDERS) };
    set({ settings });
    persist(settings);
  },

  setHarnessHomeDir: (dir) => {
    const settings = { ...get().settings, harnessHomeDir: dir };
    set({ settings });
    persist(settings);
  }
}));
