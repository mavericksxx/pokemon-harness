import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { PtyManager } from './pty';
import { HookBridge } from './hookBridge';
import { fetchSpriteGif, getCachedSprite, saveCachedSprite } from './spriteCache';
import { ensureMusicTrack } from './musicCache';
import { ensureCry } from './cryCache';
import { loadAudioSettings, saveAudioSettings } from './audioSettings';
import type {
  LazySpriteMeta,
  RendererCrashInfo,
  SessionRecord,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { AudioSettings, MusicTrackId } from '../shared/audioTypes';

// Audio (Phase 7): SFX is ON by default, and a cry can fire the instant a
// session's walker first spawns — before the user has clicked anything.
// Chromium suspends a page's AudioContext until a user gesture by default,
// which would silently drop that first sound. This is a local, single-
// purpose desktop app (no arbitrary untrusted autoplaying web content), so
// lifting the gesture requirement is a deliberate choice, not an overlooked
// default. Must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
const hookBridge = new HookBridge(app.getPath('userData'), () => mainWindow?.webContents ?? null);
const ptyManager = new PtyManager(hookBridge);

/** Set the instant a renderer crash triggers the auto-reload below, cleared
 *  once the freshly-booted renderer asks for it — see that handler's
 *  comment for why this is pulled rather than pushed. */
let pendingCrashInfo: RendererCrashInfo | null = null;

/** Mirror of the renderer's session list — the metadata `ptyManager` doesn't
 *  itself hold (species, shiny, accumulated work time, provider, title...).
 *  The renderer pushes its whole list here on every store change
 *  (`sessions:checkpoint`), so a renderer crash's reload has something to
 *  rebuild from (`sessions:restore`). Wholesale-replaced rather than
 *  upserted/deleted piecemeal: the renderer's array is already the source of
 *  truth for additions/removals, so mirroring it verbatim can't drift. Lives
 *  only as long as this process — no disk persistence (that's Phase 8.5). */
let sessionRegistry: SessionRecord[] = [];

/** Last checkpointed `selectedId`, mirrored the same way as sessionRegistry
 *  — so restore reselects whatever tab was actually open, not just the first
 *  session. */
let lastSelectedId: string | null = null;

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

  // A renderer OOM-kill or fatal GPU/WebGL loss leaves the native chrome (this
  // window, its title bar) alive but the page a permanent white screen — the
  // whole garden is drawn by the renderer that just died. Reload instead of
  // leaving the user stuck. Session PTYs live in `ptyManager`, in this
  // process, so they're untouched by a renderer crash; the reloaded page's
  // boot sequence re-adopts them via `sessions:restore` (below), using
  // `sessionRegistry` for the metadata a bare PTY doesn't carry and
  // `ptyManager.getReplay` for terminal backfill.
  //
  // pendingCrashInfo is polled (`app:consumeCrashInfo`, below) rather than
  // pushed over a one-shot `did-finish-load` + `send`: `did-finish-load`
  // fires once the page's own resources are loaded, which is no guarantee
  // the fresh React tree has mounted and subscribed to a broadcast channel
  // yet — a push here races that subscription and can drop the toast
  // silently. A pull the renderer makes once it's actually ready has no such
  // race.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[main] renderer process gone — reason: ${details.reason}, exitCode: ${details.exitCode}`
    );
    pendingCrashInfo = { reason: details.reason, exitCode: details.exitCode };
    win.webContents.reload();
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

// ─── Crash recovery ─────────────────────────────────────────────────────────
// See the `render-process-gone` handler in createWindow(): the freshly-booted
// renderer calls this once it's actually mounted, rather than main pushing it
// over a one-shot event the renderer might not be listening for yet.
ipcMain.handle('app:consumeCrashInfo', () => {
  const info = pendingCrashInfo;
  pendingCrashInfo = null;
  return info;
});

// Renderer → main mirror, called on every session-list or selection change
// (see `startRegistrySync` in src/renderer/src/sessions.ts) — see
// sessionRegistry's own comment above for why this replaces wholesale rather
// than upserting.
ipcMain.handle('sessions:checkpoint', (_e, sessions: SessionRecord[], selectedId: string | null) => {
  sessionRegistry = sessions;
  lastSelectedId = selectedId;
});

// Boot-time pull, for both a crash-triggered reload and a plain dev Cmd+R:
// only sessions whose PTY is still actually alive come back — a session
// whose process had already exited before the reload has nothing live to
// reattach to, so its tab just doesn't reappear (its checkpoint may still be
// sitting in sessionRegistry from before the exit; ptyManager.list() is the
// authority here, not the mirror). Same liveness check for selectedId: no
// point reselecting a tab that isn't coming back.
ipcMain.handle('sessions:restore', () => {
  const liveIds = new Set(ptyManager.list().map((p) => p.id));
  const sessions = sessionRegistry
    .filter((s) => liveIds.has(s.id))
    .map((session) => ({ session, replay: ptyManager.getReplay(session.id) }));
  const selectedId = lastSelectedId && liveIds.has(lastSelectedId) ? lastSelectedId : null;
  return { sessions, selectedId };
});

// ─── Lazy sprite cache (Phase 3 §2) ────────────────────────────────────────
// Main is the only network and disk actor here: the renderer's CSP has no
// 'unsafe-eval' script-src beyond self and no external connect-src, so it can
// neither fetch Showdown directly nor reach outside contextBridge to touch
// userData. Decoding/re-encoding happens renderer-side (it has a canvas).
ipcMain.handle('sprites:getCached', (_e, id: string, view: SpriteView, shiny: boolean) =>
  getCachedSprite(id, view, shiny)
);
ipcMain.handle('sprites:fetchGif', (_e, id: string, view: SpriteView, shiny: boolean) =>
  fetchSpriteGif(id, view, shiny)
);
ipcMain.handle(
  'sprites:saveCache',
  (_e, id: string, view: SpriteView, shiny: boolean, png: ArrayBuffer, meta: LazySpriteMeta) =>
    saveCachedSprite(id, view, shiny, png, meta)
);

// ─── Audio (Phase 7) ────────────────────────────────────────────────────────
// Same rationale as the sprite cache above: the renderer's CSP has no
// connect-src beyond self, so main is the only actor that can reach khinsider
// or Showdown's cry endpoint; it also owns the userData disk cache and the
// settings JSON (see audioSettings.ts — no other persistence precedent
// existed in this app to follow instead).
ipcMain.handle('audio:getSettings', () => loadAudioSettings());
ipcMain.handle('audio:saveSettings', (_e, settings: AudioSettings) => saveAudioSettings(settings));
ipcMain.handle('audio:ensureTrack', (_e, id: MusicTrackId) => ensureMusicTrack(id));
ipcMain.handle('audio:ensureCry', (_e, id: string) => ensureCry(id));

// ─── Config ─────────────────────────────────────────────────────────────────
// The renderer is sandboxed and cannot reliably read process.env itself; main
// definitely can. Lets POKE_EVOLVE_SECONDS accelerate evolution for demos/tests.
ipcMain.handle('config:evolveSeconds', () => process.env.POKE_EVOLVE_SECONDS ?? null);
// Phase 5 §1: POKE_SHINY_ODDS overrides the 1-in-N shiny roll (e.g. "1" =
// always shiny, for demos/tests).
ipcMain.handle('config:shinyOdds', () => process.env.POKE_SHINY_ODDS ?? null);

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
