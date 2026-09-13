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

/** Call once, at boot (main.tsx) — a single always-on IPC subscription wired
 *  before the async boot-recovery work, same shape as
 *  `startQuitInterceptListener` below. */
export function startUpdateCheckListener(): void {
  window.api.onUpdateAvailable((result) => showUpdateToast(result));
}

/**
 * Quit-intercept dialog (parity sweep item 2) — main asks the renderer to
 * show the "N agents still running" dialog whenever an actual QUIT (Cmd+Q /
 * Dock quit / app-menu Quit) was prevented because sessions are live (see
 * main/index.ts's `before-quit` guard). A plain window close no longer goes
 * through this at all — it just hides the window. Call once, at boot — same
 * wiring as `startUpdateCheckListener` above. Moved here (its original home
 * guarded against a since-removed sunset-ritual feature that no longer
 * exists).
 */
export function startQuitInterceptListener(): void {
  window.api.onQuitRequested((count) => {
    useStore.getState().setQuitDialogOpen(true, count);
  });
}
