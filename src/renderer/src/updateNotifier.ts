/**
 * Auto-update — the renderer half. Main does the actual check/download
 * (electron-updater, main/autoUpdate.ts) and pushes every status change
 * here (`update:status`); this is the only place that subscribes to that
 * push, writing it into the shared store (`useStore`'s `updateStatus`) so
 * SettingsPanel/QuickSettings both read one source instead of each running
 * their own IPC subscription. On `'downloaded'`, also fires a toast with an
 * "install" action — a convenience nudge, not the only path to install (the
 * persistent affordance lives in Settings/QuickSettings, driven off the
 * store).
 */
import { useStore } from '@/store/store';
import type { UpdateStatus } from '@shared/updateTypes';

export function showUpdateDownloadedToast(status: UpdateStatus): void {
  useStore.getState().pushToast(`pokéharness ${status.latestVersion ?? ''} downloaded — install`, {
    label: 'install',
    onClick: () => void window.api.installUpdate()
  });
}

/** Call once, at boot (main.tsx) — a single always-on IPC subscription wired
 *  before the async boot-recovery work, same shape as
 *  `startQuitInterceptListener` below. Also hydrates the store once from
 *  `getUpdateStatus()` so a late-mounted renderer (a reload after the
 *  background check already ran) starts with the real current status
 *  instead of the store's `idle` default. */
export function startUpdateCheckListener(): void {
  void window.api.getUpdateStatus().then((status) => useStore.getState().setUpdateStatus(status));
  window.api.onUpdateStatus((status) => {
    useStore.getState().setUpdateStatus(status);
    if (status.state === 'downloaded') showUpdateDownloadedToast(status);
  });
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
