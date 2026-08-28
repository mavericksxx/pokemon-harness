/**
 * Tier-1 update check (ship-cut item 4) — the renderer half. Main does the
 * actual GitHub check (launch + every 24h, main/index.ts's
 * `scheduleUpdateChecks`) and only ever pushes here when it found something
 * newer; this just turns that push into a toast. The Settings panel's own
 * "check now" button calls `window.api.checkForUpdateNow()` directly rather
 * than going through this listener — see SettingsPanel.tsx.
 */
import { useStore } from '@/store/store';
import type { UpdateCheckResult } from '@shared/updateTypes';

/** Design-tone toast text for a found update — shared with SettingsPanel's
 *  "check now" path so the wording is identical either way it's triggered. */
export function updateToastText(result: UpdateCheckResult): string {
  return `pokéharness ${result.latestVersion} is out — download`;
}

export function showUpdateToast(result: UpdateCheckResult): void {
  useStore.getState().pushToast(updateToastText(result), {
    label: 'download',
    onClick: () => void window.api.openExternal(result.releaseUrl)
  });
}

/** Call once, at boot (main.tsx) — mirrors closingTime.ts's
 *  `startQuitInterceptListener` shape (a single always-on IPC subscription
 *  wired before the async boot-recovery work). */
export function startUpdateCheckListener(): void {
  window.api.onUpdateAvailable((result) => showUpdateToast(result));
}
