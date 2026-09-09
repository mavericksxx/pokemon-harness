import { contextBridge, ipcRenderer } from 'electron';
import type { TrayPopoverData } from '../shared/trayTypes';

/** The tray popover's entire privileged surface — deliberately tiny: it's a
 *  read-only glanceable panel (issue #17), not the main renderer's React
 *  app, so it doesn't need anywhere near the main preload's surface (pty
 *  control, session IPC, etc.). Same sandboxed contextBridge pattern as
 *  src/preload/index.ts. Pull-based (`getData`), not a push subscription —
 *  the page calls this itself, on load and again every time it becomes
 *  visible (see trayPopoverHtml.ts's own comment) — because a main-pushed
 *  snapshot after `show()` can race the page's own listener registration on
 *  a cold first open (tray.ts's `init()` has the fuller story: that race
 *  shipped once, silently stuck the popover on "loading…" forever, and was
 *  caught before merge). */
const api = {
  getData: (): Promise<TrayPopoverData> => ipcRenderer.invoke('tray:getData'),
  /** Closes the popover — used by the panel's own dismiss affordances
   *  (Escape key). Clicking outside is handled window-side by tray.ts's own
   *  `blur` listener, so this only covers the in-page case. */
  close: (): void => {
    ipcRenderer.send('tray:close');
  }
};

contextBridge.exposeInMainWorld('trayApi', api);

export type TrayApi = typeof api;
