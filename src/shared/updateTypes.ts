/**
 * Auto-update (electron-updater on top of the manually-triggered GitHub
 * Action release) — the status machine main pushes to the renderer.
 * See src/main/autoUpdate.ts for the actual check/download/install logic.
 */
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  /** 'downloading' only — 0-100. */
  progress?: number;
  /** 'downloaded' only — the raw update zip electron-updater downloaded to
   *  its cache dir (NOT a ready-to-run installer). Also used as the
   *  install-failure fallback's `shell.showItemInFolder` target — see
   *  SettingsPanel.tsx/QuickSettings.tsx's 'error' copy for what the user
   *  actually has to do with it (quit, unzip, drag to Applications). */
  downloadedFilePath?: string;
  /** 'error' only. */
  message?: string;
}

export interface InstallResult {
  ok: boolean;
  reason?: 'not-downloaded' | 'install-failed';
}
