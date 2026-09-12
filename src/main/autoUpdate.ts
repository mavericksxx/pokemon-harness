/**
 * Auto-update — electron-updater on top of the manually-triggered GitHub
 * Action release (.github/workflows/release.yml). Replaces the old
 * hand-rolled tier-1 "latest release" poller (updateCheck.ts, deleted):
 * electron-updater reads the feed URL from the auto-generated
 * `app-update.yml` (built from package.json's `build.publish`), checks every
 * `UPDATE_CHECK_INTERVAL_MS` (plus on demand), downloads a found update in
 * the background, and lets the user finish the install with one click.
 *
 * Hard constraint: this app is ad-hoc signed (no paid Apple Developer ID —
 * see build/afterSign.cjs's header). Squirrel.Mac (electron-updater's mac
 * backend) will likely refuse to silently swap the app bundle —
 * `quitAndInstall()` is expected to fail its own signature check. So
 * `installUpdate()` below attempts it, then falls back to revealing the
 * downloaded update in Finder for one manual Gatekeeper-approval click if it
 * fails. This can only be confirmed against a real tagged release.
 */
import { app, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './diagnostics';
import type { InstallResult, UpdateState, UpdateStatus } from '../shared/updateTypes';

/** Same cadence family as the old tier-1 checker's 24h, now 4h per the "auto
 *  check + auto download in the background" requirement. */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface AutoUpdateDeps {
  getMainWindow: () => BrowserWindow | null;
  /** Reused from the existing quit-confirmation gate (main/index.ts) — see
   *  `installUpdate`'s own comment for why these must be pre-cleared before
   *  `quitAndInstall()`. */
  setQuitConfirmed: (v: boolean) => void;
  setLeaveSessionsRunning: (v: boolean) => void;
}

let deps: AutoUpdateDeps | null = null;
let initialized = false;

/** True only while `installUpdate()` is waiting for `quitAndInstall()` to
 *  either actually quit the process or fail its mac signature check — see
 *  `installUpdate` and the `error` listener below for how this closes the
 *  loop without a timing-based guess. */
let installInFlight = false;

let currentStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion()
};

/** Rebuilds status per-transition rather than merging the whole previous
 *  object over it: only `latestVersion` (the identity of "which release are
 *  we talking about") carries forward automatically across events in the
 *  same check/download/install cycle. Every other field (`progress`,
 *  `downloadedFilePath`, `message`) must be supplied explicitly by the
 *  caller for the state it actually applies to — otherwise, e.g., a plain
 *  offline background check landing right after a completed download would
 *  inherit that download's stale `downloadedFilePath` and the UI would
 *  wrongly claim it "revealed the download in Finder" for an unrelated
 *  network failure. */
function setStatus(patch: Partial<UpdateStatus> & { state: UpdateState }): void {
  currentStatus = {
    currentVersion: app.getVersion(),
    latestVersion: currentStatus.latestVersion,
    ...patch
  };
  const wc = deps?.getMainWindow()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('update:status', currentStatus);
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

/** Wires event listeners + config. Call once at boot (main/index.ts), same
 *  as the old module's implicit singleton setup. Safe to call in a dev
 *  build — the listeners are harmless, only actual checks are gated on
 *  `app.isPackaged` (see `scheduleUpdateChecks`/`checkForUpdateNow`). */
export function initAutoUpdate(d: AutoUpdateDeps): void {
  if (initialized) return;
  initialized = true;
  deps = d;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (message) => log('autoUpdate', 'info', String(message)),
    warn: (message) => log('autoUpdate', 'warn', String(message)),
    error: (message) => log('autoUpdate', 'error', String(message))
  };

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'downloading', latestVersion: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    setStatus({ state: 'not-available', latestVersion: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    setStatus({ state: 'downloading', progress: progress.percent });
  });
  autoUpdater.on('update-downloaded', (event) => {
    setStatus({ state: 'downloaded', latestVersion: event.version, downloadedFilePath: event.downloadedFile });
  });
  autoUpdater.on('error', (error) => {
    // A mac signature-validation failure inside `quitAndInstall()` (see
    // `installUpdate` below) surfaces here, not as a rejection — Squirrel.Mac
    // only actually fetches/unzips/verifies the update once quitAndInstall
    // is called, so there is no fixed grace window to wait out; this IS the
    // failure signal, whenever it arrives.
    if (installInFlight) {
      installInFlight = false;
      // Undo the pre-clear `installUpdate` did for `quitAndInstall()`'s
      // before-quit gate — the quit didn't actually happen, so the app must
      // go back to requiring confirmation on the next real quit, or it'd
      // silently skip the "N agents still running" dialog forever after a
      // failed install attempt.
      deps?.setQuitConfirmed(false);
      deps?.setLeaveSessionsRunning(false);
      const filePath = currentStatus.downloadedFilePath;
      if (filePath) shell.showItemInFolder(filePath);
      setStatus({ state: 'error', message: error.message, downloadedFilePath: filePath });
      return;
    }
    setStatus({ state: 'error', message: error.message });
  });
}

/** Once at launch, then every 4h for as long as the app stays open — no-op
 *  in a dev build (no `app-update.yml` to read). */
export function scheduleUpdateChecks(): void {
  if (!app.isPackaged) {
    log('autoUpdate', 'info', 'scheduleUpdateChecks skipped — not a packaged build');
    return;
  }
  void checkForUpdateNow();
  setInterval(() => void checkForUpdateNow(), UPDATE_CHECK_INTERVAL_MS);
}

/** Settings/QuickSettings' "check now" button, and the background 4h tick.
 *  Both land on the same `update:status` push — there's no separate
 *  "on demand" result shape. */
export async function checkForUpdateNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    log('autoUpdate', 'info', 'checkForUpdateNow skipped — not a packaged build');
    setStatus({ state: 'error', message: 'not available in a dev build' });
    return currentStatus;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    // electron-updater's own 'error' event listener above already recorded
    // this into currentStatus — nothing further to do here.
    log('autoUpdate', 'warn', 'checkForUpdates rejected', {
      message: e instanceof Error ? e.message : String(e)
    });
  }
  return currentStatus;
}

/** "Install" button — attempts `quitAndInstall()`, falling back (via the
 *  `error` listener registered in `initAutoUpdate`) to revealing the
 *  download in Finder if mac's ad-hoc-signature check makes electron-updater
 *  refuse the silent swap (see this file's header). Resolves immediately
 *  once the attempt is underway rather than waiting on a fixed timer — on
 *  mac, Squirrel only fetches/unzips/verifies the update inside
 *  `quitAndInstall()` itself, so there's no reliable grace window to guess;
 *  the real outcome (quit, or the `error` event above) arrives on its own
 *  schedule and is what the renderer's `updateStatus` push reflects. */
export async function installUpdate(): Promise<InstallResult> {
  if (currentStatus.state !== 'downloaded') return { ok: false, reason: 'not-downloaded' };
  if (!deps) return { ok: false, reason: 'install-failed' };

  installInFlight = true;
  // quitAndInstall() triggers app quit, which routes through this app's own
  // before-quit handler — if sessions are running and quitConfirmed is still
  // false, that handler pops its own dialog and silently blocks the install
  // with no error event at all. Pre-clear it the same way the existing
  // "leave running and quit" action does (app.ts's app:leaveRunningAndQuit).
  // If the install actually fails, the `error` listener above undoes this.
  deps.setQuitConfirmed(true);
  deps.setLeaveSessionsRunning(true);
  autoUpdater.quitAndInstall();

  return { ok: true };
}
