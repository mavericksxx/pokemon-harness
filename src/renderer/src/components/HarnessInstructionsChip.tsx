import { useAppSettingsStore } from '@/store/appSettingsStore';

/**
 * Topbar indicator (HARNESS.md follow-up item 3) — a small "harness.md" pill
 * in the right-hand `.topbar-actions` cluster, shown only while
 * `harnessInstructionsEnabled` is on (the toggle lives in both
 * QuickSettings.tsx and SettingsPanel.tsx). Renders nothing when the setting
 * is off, so it never reflows the cluster for users who don't use it.
 * Clicking it opens HARNESS.md the same way SettingsPanel's own "open file"
 * button does. Styled off `.usage-chip`'s tokens (same `--topbar-icon-size`
 * height) rather than duplicating them.
 */
export function HarnessInstructionsChip(): JSX.Element | null {
  const harnessInstructionsEnabled = useAppSettingsStore((s) => s.settings.harnessInstructionsEnabled);

  if (!harnessInstructionsEnabled) return null;

  return (
    <button
      type="button"
      className="tip harness-instructions-chip"
      data-tip="HARNESS.md is loaded into every new session — click to open it"
      aria-label="HARNESS.md is loaded into every new session"
      onClick={() => void window.api.openHarnessInstructions()}
    >
      harness.md
    </button>
  );
}
