import { useAppSettingsStore } from '@/store/appSettingsStore';
import { resolveEffectiveTheme } from '@/design/theme';
import { SunIcon, MoonIcon } from '@/components/icons';

/**
 * Compact topbar light/dark flip (theme settings addendum) — the full
 * system/light/dark picker stays in SettingsPanel; this is a quick way to
 * flip without opening it. Reads/writes the SAME `appSettingsStore.theme`
 * setting the settings panel does (no second source of truth) — a click
 * pins the mode to the opposite of whatever's currently effective, same as
 * most apps' quick theme toggles (it overrides an active 'system' pin,
 * rather than trying to cycle through all three states from a single
 * two-icon control).
 */
export function ThemeToggle(): JSX.Element {
  const theme = useAppSettingsStore((s) => s.settings.theme);
  const setTheme = useAppSettingsStore((s) => s.setTheme);
  const effective = resolveEffectiveTheme(theme);
  const isDark = effective === 'dark';

  return (
    <button
      className="icon tip"
      data-tip={isDark ? 'switch to light mode' : 'switch to dark mode'}
      aria-label={isDark ? 'switch to light mode' : 'switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
