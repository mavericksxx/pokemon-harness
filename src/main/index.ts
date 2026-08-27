import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { PtyManager } from './pty';
import type { SpawnPtyOptions } from '../shared/types';

const ptyManager = new PtyManager();
let mainWindow: BrowserWindow | null = null;

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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => ptyManager.killAll());

// ─── PTY IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', (_e, opts: SpawnPtyOptions) => ptyManager.spawn(opts));
ipcMain.handle('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data));
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  ptyManager.resize(id, cols, rows)
);
ipcMain.handle('pty:kill', (_e, id: string) => ptyManager.kill(id));
ipcMain.handle('pty:list', () => ptyManager.list());
ipcMain.handle('pty:available', (_e, command: string) => ptyManager.isCommandAvailable(command));

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
