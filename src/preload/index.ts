import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CachedSprite,
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

  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder'),

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
    ipcRenderer.invoke('audio:cacheStatus')
};

export type HarnessApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
