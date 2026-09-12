import { shell } from 'electron';
import { handle } from './handle';
import { loadAudioSettings, saveAudioSettings } from '../audioSettings';
import { loadAppSettings, saveAppSettings } from '../appSettings';
import { loadTerminalSettings, saveTerminalSettings } from '../terminalSettings';
import { ensureHarnessHome, resolveHarnessHomeDir } from '../harnessHome';
import { ensureHarnessInstructions, harnessInstructionsPath } from '../harnessInstructions';
import { arceusSystemPromptPath } from '../arceusPrompt';
import { arceusRosterFilePath } from '../arceusRosterFile';
import { saveWorkspaceRegistry } from '../workspacePersistence';
import { initDiagnostics, setDiagnosticsLoggingEnabled } from '../diagnostics';
import type { PtyManager } from '../pty';
import type { HookBridge } from '../hookBridge';
import type { UsageService } from '../usageService';
import type { AudioSettings } from '../../shared/audioTypes';
import type { AppSettings } from '../../shared/appSettingsTypes';
import type { TerminalSettings } from '../../shared/terminalTypes';
import type { WorkspaceSnapshot } from '../../shared/workspaceTypes';

export interface SettingsIpcDeps {
  ptyManager: PtyManager;
  hookBridge: HookBridge;
  usageService: UsageService;
  resolveTerminalAppearance: (theme: AppSettings['theme']) => 'light' | 'dark';
  syncKeepAwake: () => void;
  setActiveTheme: (theme: AppSettings['theme']) => void;
  setKeepAwakeEnabled: (enabled: boolean) => void;
  setCodexDelegateModel: (model: string) => void;
  /** Arceus v2 (docs/arceus-v2-plan.md §3.4 advisor follow-up) — mirrors
   *  `appSettings.autoModeByProvider.claude` so `poke-spawn`'s spawn handler
   *  (main/index.ts) respects the user's own per-provider auto-mode default,
   *  same as a manually-created session would. */
  setArceusSpawnAutoMode: (enabled: boolean) => void;
  getHarnessHomeDir: () => string;
  setHarnessHomeDir: (dir: string) => void;
  getWorkspaceRegistry: () => WorkspaceSnapshot;
  setAudioMasterMuted: (muted: boolean) => void;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    ptyManager,
    hookBridge,
    usageService,
    resolveTerminalAppearance,
    syncKeepAwake,
    setActiveTheme,
    setKeepAwakeEnabled,
    setCodexDelegateModel,
    setArceusSpawnAutoMode,
    getHarnessHomeDir,
    setHarnessHomeDir,
    getWorkspaceRegistry,
    setAudioMasterMuted
  } = deps;

  // ─── Audio (Phase 7) ────────────────────────────────────────────────────────
  // Same rationale as the sprite cache above: the renderer's CSP has no
  // connect-src beyond self, so main is the only actor that can reach khinsider
  // or Showdown's cry endpoint; it also owns the userData disk cache and the
  // settings JSON (see audioSettings.ts — no other persistence precedent
  // existed in this app to follow instead).
  handle('audio:getSettings', () => loadAudioSettings());
  handle('audio:saveSettings', async (_e, settings: AudioSettings) => {
    setAudioMasterMuted(settings.masterMuted);
    await saveAudioSettings(settings);
  });

  // ─── General app settings (parity sweep: theme, auto-permission mode,
  // keep-awake, recent folders) — same rationale as audio settings above.
  handle('appSettings:getSettings', () => loadAppSettings());
  handle('appSettings:saveSettings', async (_e, settings: AppSettings) => {
    setActiveTheme(settings.theme);
    ptyManager.setTerminalAppearance(resolveTerminalAppearance(settings.theme));
    setKeepAwakeEnabled(settings.keepAwake);
    syncKeepAwake();
hookBridge.setHideStatusline(settings.hideClaudeStatusline);
    ptyManager.setShellFallbackEnabled(settings.shellFallbackEnabled);
    // Usage-limits toggle (BACKLOG "next up" item 1) — the ONLY place a save
    // reaches usageService, so flipping it off here is what makes "toggle off
    // = zero credential access" true the instant the user unchecks it, not
    // just on next launch. Per-provider exclusion (feedback: "let the user
    // pick which providers to include") goes first, same ordering rationale as
    // the boot path above.
    usageService.setExcludedProviders(settings.usageExcludedProviders);
    usageService.setEnabled(settings.usageLimitsEnabled);
    // Diagnostics opt-in (BACKLOG friend-testing readiness) — takes effect on
    // this very save, same immediacy as the usage-limits toggle above.
    setDiagnosticsLoggingEnabled(settings.diagnosticsLoggingEnabled);

    // Harness home directory (Phase 8.7) — only re-resolves/re-ensures when it
    // actually changed, and never touches anything at the OLD location (the
    // Settings copy says changing this "moves nothing automatically"). Writing
    // the in-memory workspace registry to the NEW location right away is a
    // future write, same as any other mutation below — not a migration of
    // existing files — but it's what keeps "just point future writes at a new
    // folder" from silently losing the workspace list on next launch (that
    // folder has no workspaces.json of its own yet).
    const nextHarnessHomeDir = resolveHarnessHomeDir(settings);
    if (nextHarnessHomeDir !== getHarnessHomeDir()) {
      setHarnessHomeDir(nextHarnessHomeDir);
      await ensureHarnessHome(nextHarnessHomeDir);
      await ensureHarnessInstructions(nextHarnessHomeDir);
      saveWorkspaceRegistry(nextHarnessHomeDir, getWorkspaceRegistry());
      initDiagnostics(nextHarnessHomeDir); // future log writes only — see its own comment
    }
    // Harness-owned instructions file (HARNESS.md) — reached on every save
    // (not just a dir change) so flipping the toggle off takes effect on the
    // very next spawn, same immediacy as shellFallbackEnabled above. Re-reads
    // the path off the (possibly just-updated) harnessHomeDir.
    ptyManager.setHarnessInstructions(
      settings.harnessInstructionsEnabled,
      harnessInstructionsPath(getHarnessHomeDir())
    );
    ptyManager.setAdvisorModel(settings.advisorModel);
    // Arceus v2 — re-read on every save (not just a dir change) so this
    // stays trivially correct; cheap (two `join()` calls, no I/O).
    ptyManager.setArceusPaths(
      arceusSystemPromptPath(getHarnessHomeDir()),
      arceusRosterFilePath(getHarnessHomeDir())
    );
    setCodexDelegateModel(settings.codexDelegateModel);
    setArceusSpawnAutoMode(settings.autoModeByProvider.claude ?? false);

    await saveAppSettings(settings);
    return getHarnessHomeDir();
  });

  // ─── Harness home directory (Phase 8.7) ────────────────────────────────────
  // Pulled once at boot (main.tsx) to display the CURRENT resolved path in
  // Settings even when the setting itself is null (i.e. "use the default") —
  // only main can resolve that default (needs os.homedir()).
  handle('harnessHome:getResolvedPath', () => getHarnessHomeDir());

  // ─── Harness-owned instructions file (HARNESS.md) ──────────────────────────
  // Resolved path only (the file is seeded/ensured at boot and on every
  // harness-home-dir change above — see ensureHarnessInstructions' two call
  // sites) — Settings' "harness instructions" row displays this and its "open
  // file" button shells out to it, same shape as diagnostics:openLogs below.
  handle('harness:instructionsPath', () => harnessInstructionsPath(getHarnessHomeDir()));
  handle('harness:openInstructions', () => shell.openPath(harnessInstructionsPath(getHarnessHomeDir())));

  // ─── Terminal settings (Phase 8.5 Wave B item 3) ───────────────────────────
  handle('terminal:getSettings', () => loadTerminalSettings());
  handle('terminal:saveSettings', (_e, settings: TerminalSettings) =>
    saveTerminalSettings(settings)
  );
}
