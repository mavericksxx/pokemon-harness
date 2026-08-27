import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { PtyManager } from './pty';
import { HookBridge } from './hookBridge';
import { fetchSpriteGif, getCachedSprite, saveCachedSprite } from './spriteCache';
import type { LazySpriteMeta, SpawnPtyOptions, SpriteView } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
const hookBridge = new HookBridge(app.getPath('userData'), () => mainWindow?.webContents ?? null);
const ptyManager = new PtyManager(hookBridge);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Pokemon Harness',
    backgroundColor: '#101a12',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Privileged work stays behind the narrow contextBridge/IPC surface owned
      // by the main process, so Chromium's renderer sandbox stays on.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer drives the garden ticker and the PTY parsers; Chromium
      // throttles timers in occluded windows, which would stall both.
      backgroundThrottling: false
    }
  });

  mainWindow = win;
  ptyManager.attachWebContents(win.webContents);

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Never navigate the shell away from the app; open external links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  // Independent of any live claude session — the socket must be up before the
  // first spawn (and before any manual shim verification) ever happens.
  hookBridge.ensureFiles();
  hookBridge.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ptyManager.killAll();
  hookBridge.stop();
});

// ─── PTY IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', (_e, opts: SpawnPtyOptions) => ptyManager.spawn(opts));
ipcMain.handle('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data));
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  ptyManager.resize(id, cols, rows)
);
ipcMain.handle('pty:kill', (_e, id: string) => ptyManager.kill(id));
ipcMain.handle('pty:list', () => ptyManager.list());
ipcMain.handle('pty:available', (_e, command: string) => ptyManager.isCommandAvailable(command));

// ─── Lazy sprite cache (Phase 3 §2) ────────────────────────────────────────
// Main is the only network and disk actor here: the renderer's CSP has no
// 'unsafe-eval' script-src beyond self and no external connect-src, so it can
// neither fetch Showdown directly nor reach outside contextBridge to touch
// userData. Decoding/re-encoding happens renderer-side (it has a canvas).
ipcMain.handle('sprites:getCached', (_e, id: string, view: SpriteView) => getCachedSprite(id, view));
ipcMain.handle('sprites:fetchGif', (_e, id: string, view: SpriteView) => fetchSpriteGif(id, view));
ipcMain.handle(
  'sprites:saveCache',
  (_e, id: string, view: SpriteView, png: ArrayBuffer, meta: LazySpriteMeta) =>
    saveCachedSprite(id, view, png, meta)
);

// ─── Config ─────────────────────────────────────────────────────────────────
// The renderer is sandboxed and cannot reliably read process.env itself; main
// definitely can. Lets POKE_EVOLVE_SECONDS accelerate evolution for demos/tests.
ipcMain.handle('config:evolveSeconds', () => process.env.POKE_EVOLVE_SECONDS ?? null);

// ─── Dialog ─────────────────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async () => {
  const win = mainWindow;
  const opts = { properties: ['openDirectory', 'createDirectory'] as const };
  const res = win
    ? await dialog.showOpenDialog(win, { properties: [...opts.properties] })
    : await dialog.showOpenDialog({ properties: [...opts.properties] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});
