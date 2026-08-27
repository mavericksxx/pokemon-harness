import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CachedSprite,
  LazySpriteMeta,
  PtyExit,
  PtyInfo,
  PtyResult,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { HookEvent } from '../shared/hookEvents';

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

  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder'),

  getCachedSprite: (id: string, view: SpriteView): Promise<CachedSprite | null> =>
    ipcRenderer.invoke('sprites:getCached', id, view),
  fetchSpriteGif: (id: string, view: SpriteView): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('sprites:fetchGif', id, view),
  saveCachedSprite: (id: string, view: SpriteView, png: ArrayBuffer, meta: LazySpriteMeta): Promise<void> =>
    ipcRenderer.invoke('sprites:saveCache', id, view, png, meta),

  getEvolveSecondsOverride: (): Promise<string | null> => ipcRenderer.invoke('config:evolveSeconds')
};

export type HarnessApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
