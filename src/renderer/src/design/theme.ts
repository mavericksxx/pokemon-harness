/**
 * Theme resolution + live macOS-appearance follow (parity sweep item 3).
 * `ThemeMode` ('system' | 'light' | 'dark') is the persisted setting
 * (appSettingsStore.ts); this resolves it to the `EffectiveTheme` that
 * `applyTheme()` (tokens.ts) actually paints, and — only while the setting
 * is 'system' — keeps it in sync with a live OS appearance change.
 *
 * Uses `matchMedia('(prefers-color-scheme: dark)')` rather than a main-
 * process `nativeTheme` + IPC round trip: Chromium already tracks macOS
 * appearance changes on this query with no extra wiring, so this is the
 * simpler of the two options the task allows.
 */
import type { ThemeMode } from '@shared/appSettingsTypes';
import { applyTheme, type EffectiveTheme } from './tokens';
import { applyTerminalTheme } from '@/pty/terminalRegistry';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function terminalSpawnEnv(effectiveTheme: EffectiveTheme, baseEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    ...(baseEnv ?? {}),
    COLORFGBG: effectiveTheme === 'light' ? '0;15' : '15;0'
  };
  if (!env.TERM_PROGRAM) env.TERM_PROGRAM = 'pokeharness';
  return env;
}

/** Re-applies the theme (chrome + every open terminal) on every live OS
 *  appearance change, but only while `getMode()` currently reports 'system'
 *  — an explicit light/dark pin must not be overridden by the OS switching
 *  underneath it. `getMode` is read fresh on each event (not captured once)
 *  so this one listener, started once at boot, keeps working correctly
 *  across later setting changes. */
export function watchSystemTheme(getMode: () => ThemeMode): () => void {
  const mql = window.matchMedia(DARK_QUERY);
  const onChange = (): void => {
    if (getMode() !== 'system') return;
    const effective = resolveEffectiveTheme('system');
    applyTheme(effective);
    applyTerminalTheme(effective);
  };
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
