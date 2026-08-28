import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CachedSprite,
  DiskRestoreInfo,
  LazySpriteMeta,
  PtyExit,
  PtyInfo,
  PtyResult,
  RendererCrashInfo,
  RestoreSnapshot,
  SessionRecord,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { HookEvent } from '../shared/hookEvents';
import type { AudioSettings } from '../shared/audioTypes';
import type { TerminalSettings } from '../shared/terminalTypes';
import type { SessionCostUpdate } from '../shared/costTypes';
import type { AppSettings } from '../shared/appSettingsTypes';
import type { WorkspaceMutationResult, WorkspaceSnapshot } from '../shared/workspaceTypes';
import type { UpdateCheckResult } from '../shared/updateTypes';
import type { ArceusSummonConfig } from '../shared/arceus';
import type { DiagnosticsInfo, LogLevel } from '../shared/diagnosticsTypes';

/** The entire privileged surface the renderer gets. Keep it narrow, and keep
 *  this file to `electron` imports only — the preload runs sandboxed. */
const api = {
  spawnPty: (opts: SpawnPtyOptions): Promise<PtyResult> => ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<PtyResult> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<PtyResult> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  killPty: (id: string): Promise<PtyResult> => ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<PtyInfo[]> => ipcRenderer.invoke('pty:list'),
  isCommandAvailable: (command: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:available', command),

  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`;
    const listener = (_e: IpcRendererEvent, data: string): void => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id: string, cb: (info: PtyExit) => void): (() => void) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e: IpcRendererEvent, info: PtyExit): void => cb(info);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onHookEvent: (id: string, cb: (evt: HookEvent) => void): (() => void) => {
    const channel = `hooks:event:${id}`;
    const listener = (_e: IpcRendererEvent, evt: HookEvent): void => cb(evt);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Non-null for a while after a renderer crash's auto-reload — see
   *  main/index.ts's `render-process-gone` handler and `pendingCrashInfo`'s
   *  own comment for why this is a plain (not destructive) read. Pulled on
   *  boot rather than pushed, so there's no race with the renderer
   *  subscribing late. */
  getCrashInfo: (): Promise<RendererCrashInfo | null> => ipcRenderer.invoke('app:getCrashInfo'),

  /** Mirrors the renderer's whole session list (and current selection) into
   *  main, so a renderer crash's reload has something to rebuild from.
   *  Called on every store change — see sessions.ts's `startRegistrySync`. */
  checkpointSessions: (sessions: SessionRecord[], selectedId: string | null): Promise<void> =>
    ipcRenderer.invoke('sessions:checkpoint', sessions, selectedId),
  /** Sessions still alive (their PTY didn't exit) as of the last checkpoint,
   *  plus the last-selected id — called once on boot to re-adopt them after a
   *  crash or a plain reload. */
  restoreSessions: (): Promise<RestoreSnapshot> => ipcRenderer.invoke('sessions:restore'),
  /** Non-null exactly once, right after a launch that respawned at least one
   *  disk-persisted session (Phase 8.5 #1) — see main/index.ts's
   *  `diskRestoreConsumed`. Pulled on boot the same way `getCrashInfo` is. */
  getDiskRestoreInfo: (): Promise<DiskRestoreInfo | null> =>
    ipcRenderer.invoke('app:getDiskRestoreInfo'),

  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder'),

  /** Closing-time sunset ritual (Phase 8.5 Wave B item 2) — called after the
   *  renderer's own walk/wave/toast/audio-fade sequence finishes. */
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  getCachedSprite: (id: string, view: SpriteView, shiny: boolean): Promise<CachedSprite | null> =>
    ipcRenderer.invoke('sprites:getCached', id, view, shiny),
  fetchSpriteGif: (id: string, view: SpriteView, shiny: boolean): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('sprites:fetchGif', id, view, shiny),
  saveCachedSprite: (
    id: string,
    view: SpriteView,
    shiny: boolean,
    png: ArrayBuffer,
    meta: LazySpriteMeta
  ): Promise<void> => ipcRenderer.invoke('sprites:saveCache', id, view, shiny, png, meta),

  getEvolveSecondsOverride: (): Promise<string | null> => ipcRenderer.invoke('config:evolveSeconds'),
  getShinyOddsOverride: (): Promise<string | null> => ipcRenderer.invoke('config:shinyOdds'),
  getDefaultShell: (): Promise<string> => ipcRenderer.invoke('config:defaultShell'),

  getTerminalSettings: (): Promise<TerminalSettings> => ipcRenderer.invoke('terminal:getSettings'),
  saveTerminalSettings: (settings: TerminalSettings): Promise<void> =>
    ipcRenderer.invoke('terminal:saveSettings', settings),

  onCostUpdate: (id: string, cb: (update: SessionCostUpdate) => void): (() => void) => {
    const channel = `cost:update:${id}`;
    const listener = (_e: IpcRendererEvent, update: SessionCostUpdate): void => cb(update);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Test-only — see main/index.ts's `cost:registerTestPath` handler. */
  registerCostTestPath: (agentId: string, transcriptPath: string): Promise<void> =>
    ipcRenderer.invoke('cost:registerTestPath', agentId, transcriptPath),

  getAudioSettings: (): Promise<AudioSettings> => ipcRenderer.invoke('audio:getSettings'),
  saveAudioSettings: (settings: AudioSettings): Promise<void> =>
    ipcRenderer.invoke('audio:saveSettings', settings),
  // `id` is any mini-player catalog id (musicCatalog.ts) — includes the 9
  // original curated MusicTrackIds, which are part of that same id space.
  ensureMusicTrack: (id: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('audio:ensureTrack', id),
  ensureCry: (id: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('audio:ensureCry', id),
  prefetchMusicTrack: (id: string): Promise<'cached' | 'ok' | 'busy' | 'failed'> =>
    ipcRenderer.invoke('audio:prefetchTrack', id),
  cancelMusicPrefetch: (): Promise<void> => ipcRenderer.invoke('audio:cancelPrefetch'),
  getMusicCacheStatus: (): Promise<{ bytes: number; cap: number; headroom: number }> =>
    ipcRenderer.invoke('audio:cacheStatus'),

  // ─── General app settings (parity sweep: theme, auto-permission mode,
  // keep-awake, recent folders) — same get/save shape as audio settings above.
  getAppSettings: (): Promise<AppSettings> => ipcRenderer.invoke('appSettings:getSettings'),
  /** Resolves to the (possibly just-changed) harness home directory — see
   *  main/index.ts's `appSettings:saveSettings` handler and harnessHome.ts. */
  saveAppSettings: (settings: AppSettings): Promise<string> =>
    ipcRenderer.invoke('appSettings:saveSettings', settings),

  // ─── Harness home directory (Phase 8.7) ────────────────────────────────
  getHarnessHomePath: (): Promise<string> => ipcRenderer.invoke('harnessHome:getResolvedPath'),

  // ─── Arceus (Phase 8.8) ─────────────────────────────────────────────────
  /** Ensures agents/arceus/SYSTEM.md exists and returns its current
   *  contents + path — call fresh at every summon, never cache the result. */
  ensureArceusSystemPrompt: (): Promise<{ path: string; prompt: string }> =>
    ipcRenderer.invoke('arceus:ensureSystemPrompt'),
  /** Dev-only — see main/index.ts's `config:arceusDevStandin`. */
  getArceusDevStandin: (): Promise<boolean> => ipcRenderer.invoke('config:arceusDevStandin'),

  // ─── Arceus summon-once (Phase 8.9) — arceusSummonConfig.ts ─────────────
  /** Null if Arceus has never been summoned (or the file was reset) — the
   *  signal SummonArceusButton uses to decide dialog vs. silent auto-summon. */
  getArceusSummonConfig: (): Promise<ArceusSummonConfig | null> =>
    ipcRenderer.invoke('arceus:loadSummonConfig'),
  /** Written once, after the FIRST successful summon (SummonArceusDialog) —
   *  never called from the silent auto-summon path itself. */
  saveArceusSummonConfig: (config: ArceusSummonConfig): Promise<void> =>
    ipcRenderer.invoke('arceus:saveSummonConfig', config),
  /** Settings' "reset arceus" action — deletes the saved config, returning
   *  the app to first-run (setup dialog) behavior. */
  resetArceusSummonConfig: (): Promise<void> => ipcRenderer.invoke('arceus:resetSummonConfig'),

  // ─── Workspaces (Phase 8.7) ─────────────────────────────────────────────
  listWorkspaces: (): Promise<WorkspaceSnapshot> => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (name: string, primaryFolder: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:create', name, primaryFolder),
  renameWorkspace: (id: string, name: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:rename', id, name),
  setActiveWorkspace: (id: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:setActive', id),
  deleteWorkspace: (id: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:delete', id),

  // ─── Quit-intercept dialog (parity sweep item 2) ───────────────────────
  /** Fires when main prevented a close/quit because sessions are still live
   *  — `count` is the number of live sessions, main's own authoritative
   *  count (ptyManager.list().length), not recomputed renderer-side. */
  onQuitRequested: (cb: (count: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, count: number): void => cb(count);
    ipcRenderer.on('app:quitRequested', listener);
    return () => ipcRenderer.removeListener('app:quitRequested', listener);
  },
  /** "kill it & quit" — bypasses the sunset ritual, quits immediately. */
  forceQuit: (): Promise<void> => ipcRenderer.invoke('app:forceQuit'),

  // ─── App version + updates (ship-cut item 4) ───────────────────────────
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  /** Settings panel's "check now" — resolves either way, including a
   *  "you're already up to date" (`available: false`) result. */
  checkForUpdateNow: (): Promise<UpdateCheckResult | null> => ipcRenderer.invoke('update:checkNow'),
  /** Fires only when the background 24h/launch check (main/index.ts's
   *  `scheduleUpdateChecks`) actually finds something newer — never for a
   *  "no update" result, which stays silent by design. */
  onUpdateAvailable: (cb: (result: UpdateCheckResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, result: UpdateCheckResult): void => cb(result);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },

  // ─── Diagnostics (BACKLOG item 1) — local-only, nothing here leaves the
  // machine. ─────────────────────────────────────────────────────────────
  logDiagnostic: (area: string, level: LogLevel, message: string, data?: unknown): Promise<void> =>
    ipcRenderer.invoke('diagnostics:log', area, level, message, data),
  getDiagnosticsInfo: (): Promise<DiagnosticsInfo> => ipcRenderer.invoke('diagnostics:getInfo'),
  /** Settings panel's "open logs" button — `shell.openPath` via IPC.
   *  Resolves to '' on success, or an OS error string on failure (Electron's
   *  own shell.openPath contract) — not currently surfaced in the UI, same
   *  as every other fire-and-forget button in this panel. */
  openLogsFolder: (): Promise<string> => ipcRenderer.invoke('diagnostics:openLogs')
};

export type HarnessApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
