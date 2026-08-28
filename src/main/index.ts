import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { join } from 'node:path';
import { PtyManager } from './pty';
import { HookBridge } from './hookBridge';
import { CostWatcher } from './costWatcher';
import { fetchSpriteGif, getCachedSprite, saveCachedSprite } from './spriteCache';
import { cancelPrefetch, ensureMusicTrack, getCacheStatus, prefetchTrack } from './musicCache';
import { ensureCry } from './cryCache';
import { loadAudioSettings, saveAudioSettings } from './audioSettings';
import { loadTerminalSettings, saveTerminalSettings } from './terminalSettings';
import type {
  LazySpriteMeta,
  RendererCrashInfo,
  SessionRecord,
  SessionStatus,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { AudioSettings } from '../shared/audioTypes';
import type { TerminalSettings } from '../shared/terminalTypes';

// Audio (Phase 7): SFX is ON by default, and a cry can fire the instant a
// session's walker first spawns — before the user has clicked anything.
// Chromium suspends a page's AudioContext until a user gesture by default,
// which would silently drop that first sound. This is a local, single-
// purpose desktop app (no arbitrary untrusted autoplaying web content), so
// lifting the gesture requirement is a deliberate choice, not an overlooked
// default. Must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
// Phase 8.5 Wave B item 1 — registered off every hook payload's own
// `transcript_path` (see hookBridge.ts's `onRawPayload` param), independent
// of any one hook event.
const costWatcher = new CostWatcher(() => mainWindow?.webContents ?? null);
const hookBridge = new HookBridge(
  app.getPath('userData'),
  () => mainWindow?.webContents ?? null,
  (agentId, transcriptPath) => costWatcher.onHookPayload(agentId, transcriptPath)
);
const ptyManager = new PtyManager(hookBridge);

/** Load (or reload, after a crash) the app's page. A fresh navigation, not
 *  `webContents.reload()`: testing an induced crash (CDP's `Page.crash()`)
 *  showed `reload()` occasionally leave the window with no renderer process
 *  at all and no further navigation possible — `reload()` re-runs the
 *  existing history entry, which a crash may have left in a state Electron
 *  can't recover from. `loadURL`/`loadFile` starts a navigation from
 *  scratch, the same call the window's very first paint already uses. */
function loadApp(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

/** Crash-loop bound for the `render-process-gone` auto-reload below: give up
 *  after this many crashes inside CRASH_WINDOW_MS rather than reloading
 *  forever into a renderer that dies on every boot. Deliberately generous:
 *  live testing (CDP's `Page.crash()`) showed a single crash can fire this
 *  event more than once, and a single `loadApp` call doesn't always bring a
 *  renderer back — the handler below calls it again for every firing rather
 *  than de-duplicating, so this budget needs headroom for that, not just for
 *  distinct crashes. */
const MAX_CRASHES_PER_WINDOW = 8;
const CRASH_WINDOW_MS = 30_000;
/** How long `pendingCrashInfo` stays available to `getCrashInfo` after a
 *  crash — see that field's own comment for why this is a TTL rather than
 *  cleared on first read. */
const PENDING_CRASH_INFO_TTL_MS = 8_000;

/** The most recent crash, available to `app:getCrashInfo` for
 *  PENDING_CRASH_INFO_TTL_MS after it's set, then auto-cleared — NOT cleared
 *  on first read. A single crash can make `render-process-gone` fire more
 *  than once and can need more than one `loadApp` call to actually recover
 *  (both seen live via CDP's `Page.crash()`), which means more than one page
 *  load can happen for the same crash — an early one that gets superseded
 *  before it finishes booting, then the one that actually sticks. A
 *  clear-on-read design has the early, superseded boot consume this before
 *  the surviving one ever sees it, silently dropping the toast (sessions
 *  still restore fine either way — they come from `sessionRegistry`, which
 *  nothing here touches). The TTL trades a moment of duplicate-toast risk on
 *  a rapid repeat crash (out of scope: a REAL repeat crash of a stable app is
 *  not a rapid back-to-back event) for the surviving boot reliably seeing it. */
let pendingCrashInfo: RendererCrashInfo | null = null;
let pendingCrashInfoTimer: ReturnType<typeof setTimeout> | null = null;

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

/** Session statuses whose transition INTO deserves a native desktop
 *  notification (Phase 8 §6) — blocked (needs input) and done (finished).
 *  The in-app completion TOAST for 'done' is a separate, unconditional path
 *  (sessions.ts's `startCompletionToasts`, renderer-side) — this one is
 *  gated on window focus and only fires for the OS notification. */
const NOTIFY_STATUSES: ReadonlySet<SessionStatus> = new Set(['blocked', 'done']);

/** Diff `sessionRegistry` (the PREVIOUS checkpoint) against the incoming
 *  `nextSessions` and fire a native notification for any status transition
 *  into 'blocked' or 'done' — unless the window is focused AND the user is
 *  already looking at exactly that session (munder-difflin's gate: never
 *  notify for the focused, visible session). A brand-new session (no
 *  previous entry) never notifies here — only a change fires this, not an
 *  initial value, so a session restored already-'done' on boot stays quiet. */
function notifyStatusTransitions(nextSessions: SessionRecord[], selectedId: string | null): void {
  if (!Notification.isSupported()) return;
  const prevStatus = new Map(sessionRegistry.map((s) => [s.id, s.status]));
  const focused = mainWindow?.isFocused() ?? false;
  for (const session of nextSessions) {
    const was = prevStatus.get(session.id);
    if (was === undefined || was === session.status) continue;
    if (!NOTIFY_STATUSES.has(session.status)) continue;
    if (focused && selectedId === session.id) continue;
    const body = session.status === 'blocked' ? `${session.title} needs your input` : `${session.title} finished`;
    try {
      new Notification({ title: 'pokemon-harness', body }).show();
    } catch {
      /* unsupported/denied on this platform — best-effort, never throw into the IPC handler */
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Pokemon Harness',
    // Matches design/tokens.ts's `ground[0]` / index.css's `--bg` (Phase 8
    // §2) — this paints before the renderer does, so it has to track that
    // value by hand rather than reading it.
    backgroundColor: '#17171b',
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
  // pendingCrashInfo is polled (`app:getCrashInfo`, below) rather than
  // pushed over a one-shot `did-finish-load` + `send`: `did-finish-load`
  // fires once the page's own resources are loaded, which is no guarantee
  // the fresh React tree has mounted and subscribed to a broadcast channel
  // yet — a push here races that subscription and can drop the toast
  // silently. A pull the renderer makes once it's actually ready has no such
  // race.
  //
  // Deliberately does NOT try to de-duplicate or suppress rapid repeat
  // firings of this event before calling `loadApp` again: testing showed a
  // single crash can fire `render-process-gone` more than once, AND that a
  // single `loadApp` call after a crash doesn't always bring a renderer back
  // — a guard that skipped the second firing (tried first) reliably left the
  // window with no renderer process and no further navigation possible, i.e.
  // exactly the stuck state this handler exists to recover from. Calling
  // `loadApp` again for every firing is what's actually reliable in testing;
  // `crashTimestamps` is the only protection against a genuine crash loop.
  let crashTimestamps: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[main] renderer process gone — reason: ${details.reason}, exitCode: ${details.exitCode}`
    );

    const now = Date.now();
    crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimestamps.push(now);
    if (crashTimestamps.length > MAX_CRASHES_PER_WINDOW) {
      console.error('[main] renderer crash-looping — giving up on auto-reload');
      return;
    }

    pendingCrashInfo = { reason: details.reason, exitCode: details.exitCode };
    if (pendingCrashInfoTimer) clearTimeout(pendingCrashInfoTimer);
    pendingCrashInfoTimer = setTimeout(() => {
      pendingCrashInfo = null;
    }, PENDING_CRASH_INFO_TTL_MS);

    loadApp(win);
  });

  loadApp(win);
}

app.whenReady().then(() => {
  // Independent of any live claude session — the socket must be up before the
  // first spawn (and before any manual shim verification) ever happens.
  hookBridge.ensureFiles();
  hookBridge.start();
  costWatcher.start();
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
  costWatcher.stop();
});

// ─── PTY IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', (_e, opts: SpawnPtyOptions) => ptyManager.spawn(opts));
ipcMain.handle('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data));
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  ptyManager.resize(id, cols, rows)
);
ipcMain.handle('pty:kill', (_e, id: string) => {
  costWatcher.unregisterSession(id);
  return ptyManager.kill(id);
});
ipcMain.handle('pty:list', () => ptyManager.list());
ipcMain.handle('pty:available', (_e, command: string) => ptyManager.isCommandAvailable(command));

// ─── Crash recovery ─────────────────────────────────────────────────────────
// See the `render-process-gone` handler in createWindow(): the freshly-booted
// renderer calls this once it's actually mounted, rather than main pushing it
// over a one-shot event the renderer might not be listening for yet. A plain
// read, not a destructive one — see pendingCrashInfo's own comment for why.
ipcMain.handle('app:getCrashInfo', () => pendingCrashInfo);

// Renderer → main mirror, called on every session-list or selection change
// (see `startRegistrySync` in src/renderer/src/sessions.ts) — see
// sessionRegistry's own comment above for why this replaces wholesale rather
// than upserting.
ipcMain.handle('sessions:checkpoint', (_e, sessions: SessionRecord[], selectedId: string | null) => {
  notifyStatusTransitions(sessions, selectedId);
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
// `id` is any mini-player catalog id (musicCatalog.ts), not just the 9
// original curated MusicTrackIds — see musicCache.ts's header.
ipcMain.handle('audio:ensureTrack', (_e, id: string) => ensureMusicTrack(id));
ipcMain.handle('audio:ensureCry', (_e, id: string) => ensureCry(id));
// Background catalog-warm (mini-player generation filter) — see
// musicCache.ts's single-flight coordination.
ipcMain.handle('audio:prefetchTrack', (_e, id: string) => prefetchTrack(id));
ipcMain.handle('audio:cancelPrefetch', () => cancelPrefetch());
ipcMain.handle('audio:cacheStatus', () => getCacheStatus());

// ─── Config ─────────────────────────────────────────────────────────────────
// The renderer is sandboxed and cannot reliably read process.env itself; main
// definitely can. Lets POKE_EVOLVE_SECONDS accelerate evolution for demos/tests.
ipcMain.handle('config:evolveSeconds', () => process.env.POKE_EVOLVE_SECONDS ?? null);
// Phase 5 §1: POKE_SHINY_ODDS overrides the 1-in-N shiny roll (e.g. "1" =
// always shiny, for demos/tests).
ipcMain.handle('config:shinyOdds', () => process.env.POKE_SHINY_ODDS ?? null);
// Phase 8.5 Wave B item 3 §3 — the "plain shell" provider's actual command:
// the user's own interactive shell, which only main can read off $SHELL.
ipcMain.handle('config:defaultShell', () => process.env.SHELL || '/bin/zsh');

// ─── Terminal settings (Phase 8.5 Wave B item 3) ───────────────────────────
ipcMain.handle('terminal:getSettings', () => loadTerminalSettings());
ipcMain.handle('terminal:saveSettings', (_e, settings: TerminalSettings) =>
  saveTerminalSettings(settings)
);

// ─── Cost & context HUD (Phase 8.5 Wave B item 1) ──────────────────────────
// Test-only escape hatch: registers a session id against an arbitrary
// transcript path, bypassing the real hook payload entirely — this app is
// never allowed to spawn a real `claude` for testing (see hookRouter.ts), so
// verifying the watcher means pointing it at a synthetic transcript from a
// plain bash session instead.
ipcMain.handle('cost:registerTestPath', (_e, agentId: string, transcriptPath: string) =>
  costWatcher.registerSession(agentId, transcriptPath)
);

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
