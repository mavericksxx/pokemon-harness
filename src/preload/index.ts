import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PtyExit, PtyInfo, PtyResult, SpawnPtyOptions } from '../shared/types';

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

  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder')
};

export type HarnessApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
