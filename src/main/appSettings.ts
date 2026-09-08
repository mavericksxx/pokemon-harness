/**
 * General app settings (theme, auto-permission-mode per provider, keep-awake,
 * recent folders — parity sweep), persisted as a plain JSON file under
 * userData. Mirrors `audioSettings.ts`'s shape exactly (see that file's
 * header for why a plain JSON file rather than a new dependency).
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeJsonAtomic } from './atomicWrite';
import { AGENT_PROVIDERS, type AgentProviderId, DEFAULT_PROVIDER } from '../shared/agentProvider';
import { DEFAULT_APP_SETTINGS, type AppSettings, type ThemeMode } from '../shared/appSettingsTypes';
import type { UsageProviderId } from '../shared/usageTypes';

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json');
}

const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const USAGE_PROVIDER_IDS: readonly UsageProviderId[] = ['claude', 'codex'];

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** JSON is user-editable, so every field gets its own shape check before the
 *  renderer ever sees it — a malformed/stale value silently falls back to
 *  its default rather than reaching (and possibly breaking) a consumer
 *  downstream. Mutates `settings` (already merged over the defaults) in
 *  place, field by field. */
function sanitizeAppSettings(settings: AppSettings): AppSettings {
  settings.theme = oneOf(settings.theme, THEME_MODES, DEFAULT_APP_SETTINGS.theme);
  // Malformed or stale provider id from reaching the renderer and breaking
  // the New Session dialog.
  if (!AGENT_PROVIDERS[settings.defaultAgentProvider]) settings.defaultAgentProvider = DEFAULT_PROVIDER;
  if (typeof settings.autoModeByProvider !== 'object' || settings.autoModeByProvider === null || Array.isArray(settings.autoModeByProvider)) {
    settings.autoModeByProvider = { ...DEFAULT_APP_SETTINGS.autoModeByProvider };
  } else {
    const cleaned: Partial<Record<AgentProviderId, boolean>> = {};
    for (const [providerId, enabled] of Object.entries(settings.autoModeByProvider)) {
      if (AGENT_PROVIDERS[providerId as AgentProviderId] && typeof enabled === 'boolean') {
        cleaned[providerId as AgentProviderId] = enabled;
      }
    }
    settings.autoModeByProvider = cleaned;
  }
  settings.keepAwake = bool(settings.keepAwake, DEFAULT_APP_SETTINGS.keepAwake);
  settings.recentFolders = stringArray(settings.recentFolders);
  // Non-empty and not absolute means the value can't have come from
  // Settings' own folder picker (main.ts's resolveHarnessHomeDir always
  // hands back an absolute path) — a hand-edited relative path here would
  // resolve differently depending on process.cwd() at call time.
  if (settings.harnessHomeDir !== null && (typeof settings.harnessHomeDir !== 'string' || (settings.harnessHomeDir !== '' && !isAbsolute(settings.harnessHomeDir)))) {
    settings.harnessHomeDir = DEFAULT_APP_SETTINGS.harnessHomeDir;
  }
  settings.hideClaudeStatusline = bool(settings.hideClaudeStatusline, DEFAULT_APP_SETTINGS.hideClaudeStatusline);
  settings.shellFallbackEnabled = bool(settings.shellFallbackEnabled, DEFAULT_APP_SETTINGS.shellFallbackEnabled);
  settings.usageLimitsEnabled = bool(settings.usageLimitsEnabled, DEFAULT_APP_SETTINGS.usageLimitsEnabled);
  settings.usageExcludedProviders = stringArray(settings.usageExcludedProviders).filter((id): id is UsageProviderId =>
    (USAGE_PROVIDER_IDS as readonly string[]).includes(id)
  );
  settings.mainUsageProvider = oneOf(settings.mainUsageProvider, [...USAGE_PROVIDER_IDS, 'auto'], DEFAULT_APP_SETTINGS.mainUsageProvider);
  settings.diagnosticsLoggingEnabled = bool(settings.diagnosticsLoggingEnabled, DEFAULT_APP_SETTINGS.diagnosticsLoggingEnabled);
  settings.codexDelegateHooks = bool(settings.codexDelegateHooks, DEFAULT_APP_SETTINGS.codexDelegateHooks);
  settings.lowResGarden = bool(settings.lowResGarden, DEFAULT_APP_SETTINGS.lowResGarden);
  settings.harnessInstructionsEnabled = bool(settings.harnessInstructionsEnabled, DEFAULT_APP_SETTINGS.harnessInstructionsEnabled);
  settings.advisorModel = str(settings.advisorModel, DEFAULT_APP_SETTINGS.advisorModel);
  settings.codexDelegateModel = str(settings.codexDelegateModel, DEFAULT_APP_SETTINGS.codexDelegateModel);
  settings.onboardingDone = bool(settings.onboardingDone, DEFAULT_APP_SETTINGS.onboardingDone);
  return settings;
}

export async function loadAppSettings(): Promise<AppSettings> {
  const p = settingsPath();
  if (!existsSync(p)) return { ...DEFAULT_APP_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<AppSettings>;
    // Merge over defaults so an older settings file missing a newly-added key
    // doesn't produce `undefined` for it.
    const settings = { ...DEFAULT_APP_SETTINGS, ...raw };
    return sanitizeAppSettings(settings);
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await writeJsonAtomic(settingsPath(), settings);
}
