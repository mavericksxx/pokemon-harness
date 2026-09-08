import { ipcMain } from 'electron';
import { log } from '../diagnostics';

// ─── IPC failure capture (BACKLOG friend-testing readiness) ────────────────
// A thrown/rejected `ipcMain.handle` listener is caught INSIDE Electron's own
// invoke bridge and turned into a rejection on the renderer's `invoke()` call
// — it never reaches this process's `uncaughtException`/`unhandledRejection`
// handlers above, so a bug in any one of the ~50 handlers below had zero
// trace in harness.log until now. Every registration in this file goes
// through this thin wrapper instead of `ipcMain.handle` directly so a throw
// surfaces here once, without touching any handler's own body; the original
// rejection still propagates to the caller exactly as before (the `throw`
// below), so no existing renderer-side error handling changes.
type IpcListener = Parameters<typeof ipcMain.handle>[1];
export function handle(channel: string, fn: IpcListener): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      log('ipc', 'error', `handler threw: ${channel}`, {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
      throw e;
    }
  });
}
