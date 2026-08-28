import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, powerSaveBlocker, shell } from 'electron';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { PtyManager } from './pty';
import { HookBridge } from './hookBridge';
import { CostWatcher } from './costWatcher';
import { fetchSpriteGif, getCachedSprite, saveCachedSprite } from './spriteCache';
import { cancelPrefetch, ensureMusicTrack, getCacheStatus, prefetchTrack } from './musicCache';
import { ensureCry } from './cryCache';
import { loadAudioSettings, saveAudioSettings } from './audioSettings';
import { loadAppSettings, saveAppSettings } from './appSettings';
import { loadPersistedSessions, SessionPersistence } from './sessionPersistence';
import { respawnSession } from './sessionRespawn';
import { loadTerminalSettings, saveTerminalSettings } from './terminalSettings';
import { defaultHarnessHomeDir, ensureHarnessHome, resolveHarnessHomeDir } from './harnessHome';
import { ensureArceusSystemPrompt } from './arceusPrompt';
import { initWorkspaceRegistry, saveWorkspaceRegistry } from './workspacePersistence';
import type {
  DiskRestoreInfo,
  LazySpriteMeta,
  RendererCrashInfo,
  SessionRecord,
  SessionStatus,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { AudioSettings } from '../shared/audioTypes';
import type { AppSettings } from '../shared/appSettingsTypes';
import type { TerminalSettings } from '../shared/terminalTypes';
import { DEFAULT_WORKSPACE_ID, type WorkspaceRecord, type WorkspaceSnapshot } from '../shared/workspaceTypes';

// Audio (Phase 7): SFX is ON by default, and a cry can fire the instant a
// session's walker first spawns — before the user has clicked anything.
// Chromium suspends a page's AudioContext until a user gesture by default,
// which would silently drop that first sound. This is a local, single-
// purpose desktop app (no arbitrary untrusted autoplaying web content), so
// lifting the gesture requirement is a deliberate choice, not an overlooked
// default. Must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Ship-cut item 1 (rename): the packaged app's dock/menu identity comes from
// package.json's `productName` via Info.plist, but `app.getName()` in a DEV
// run falls back to the ascii npm `name` ("pokeharness") unless overridden
// here — must run before `app.whenReady()` to reliably affect the dock/menu
// bar in both dev and packaged builds.
app.setName('Pokéharness');

let mainWindow: BrowserWindow | null = null;

// ─── Quit-intercept dialog (parity sweep item 2) ───────────────────────────
// Set once a quit is CONFIRMED — either the sunset ritual's own final quit
// (the `app:quit` handler below, which the ritual is the only caller of) or
// the quit dialog's "kill it & quit" action (`app:forceQuit`). While false,
// both a window close and an app quit are intercepted whenever a session is
// still live, and the renderer is asked to show the quit dialog instead.
let quitConfirmed = false;
function hasLiveSessions(): boolean {
  return ptyManager.list().length > 0;
}
function requestQuitConfirmation(): void {
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send('app:quitRequested', ptyManager.list().length);
}
// Phase 8.5 Wave B item 1 — registered off every hook payload's own
// `transcript_path` (see hookBridge.ts's `onRawPayload` param), independent
// of any one hook event.
const costWatcher = new CostWatcher(() => mainWindow?.webContents ?? null);
const hookBridge = new HookBridge(
  app.getPath('userData'),
  () => mainWindow?.webContents ?? null,
  (agentId, transcriptPath) => costWatcher.onHookPayload(agentId, transcriptPath)
);
const ptyManager = new PtyManager(hookBridge, () => syncKeepAwake());
const sessionPersistence = new SessionPersistence(app.getPath('userData'));

// ─── Harness home directory + workspaces (Phase 8.7) ───────────────────────
// Resolved for real (against the persisted setting) in `app.whenReady()`,
// before `restoreFromDisk()` — this module-scope default just gives every
// reference below a sane value in the window before that (nothing can
// actually need it that early). See harnessHome.ts.
let harnessHomeDir = defaultHarnessHomeDir();
// Populated for real inside `restoreFromDisk()` (it needs the first
// persisted session's cwd, if any, to name a migrated default workspace) —
// this single-workspace placeholder just keeps every reader (notably
// `notifyStatusTransitions`) valid before that resolves, mirroring how
// `sessionRegistry` starts empty rather than undefined.
let workspaceRegistry: WorkspaceSnapshot = {
  workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'garden 1', primaryFolder: homedir(), createdAt: Date.now() }],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID
};

// ─── Keep-awake (parity sweep item 4) ──────────────────────────────────────
// Holds a powerSaveBlocker while the setting is ON and at least one session
// is live; releases it the moment either condition stops holding. Driven off
// ptyManager's own live-session count (PtyManager's `onSessionsChanged`
// callback above, plus the setting-change path in `appSettings:saveSettings`
// below) — not the renderer's session list, which also contains 'done'
// sessions whose PTY has already exited.
let keepAwakeEnabled = false;
let keepAwakeBlockerId: number | null = null;
function syncKeepAwake(): void {
  const shouldHold = keepAwakeEnabled && ptyManager.list().length > 0;
  if (shouldHold) {
    if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (keepAwakeBlockerId !== null) {
    if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) powerSaveBlocker.stop(keepAwakeBlockerId);
    keepAwakeBlockerId = null;
  }
}

// Dark ground[0] / light groundLight[0] (design/tokens.ts) — the window's
// `backgroundColor` paints before the renderer does, so (like the existing
// dark-only value this replaces) it has to track those values by hand rather
// than reading them. Resolved against the persisted theme setting (falling
// back to the OS preference for 'system') right before window creation, so
// a light-theme user never sees a dark flash on launch.
const WINDOW_BG_DARK = '#17171b';
const WINDOW_BG_LIGHT = '#fffdf5';
function resolveWindowBg(theme: AppSettings['theme']): string {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? WINDOW_BG_DARK : WINDOW_BG_LIGHT;
}

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
 *  already looking at exactly that session IN ITS OWN (active) workspace
 *  (munder-difflin's gate: never notify for the focused, visible session).
 *  A brand-new session (no previous entry) never notifies here — only a
 *  change fires this, not an initial value, so a session restored
 *  already-'done' on boot stays quiet.
 *
 *  Workspaces (Phase 8.7): a session in a workspace OTHER than the active
 *  one still notifies even while focused+selected — you can't be "looking
 *  at" a session whose garden isn't the one on screen — and its body names
 *  the workspace, since the title alone doesn't say which garden to check. */
function notifyStatusTransitions(nextSessions: SessionRecord[], selectedId: string | null): void {
  if (!Notification.isSupported()) return;
  const prevStatus = new Map(sessionRegistry.map((s) => [s.id, s.status]));
  const focused = mainWindow?.isFocused() ?? false;
  for (const session of nextSessions) {
    const was = prevStatus.get(session.id);
    if (was === undefined || was === session.status) continue;
    if (!NOTIFY_STATUSES.has(session.status)) continue;
    const sessionWorkspaceId = session.workspaceId ?? DEFAULT_WORKSPACE_ID;
    // Arceus (Phase 8.8) is global — visible in every workspace, so he's
    // never "in another garden" the way a scoped session can be.
    const inActiveWorkspace = session.isArceus || sessionWorkspaceId === workspaceRegistry.activeWorkspaceId;
    if (focused && inActiveWorkspace && selectedId === session.id) continue;
    let body = session.status === 'blocked' ? `${session.title} needs your input` : `${session.title} finished`;
    if (!inActiveWorkspace) {
      const workspace = workspaceRegistry.workspaces.find((w) => w.id === sessionWorkspaceId);
      if (workspace) body += ` (${workspace.name})`;
    }
    try {
      new Notification({ title: 'pokéharness', body }).show();
    } catch {
      /* unsupported/denied on this platform — best-effort, never throw into the IPC handler */
    }
  }
}

/** App-launch session restoration (Phase 8.5 #1): respawns every session the
 *  last live checkpoint persisted to disk (see sessionPersistence.ts) before
 *  this process last quit, reusing the SAME ids the renderer already knows
 *  — so the existing renderer-crash adoption path (`sessions:restore`,
 *  below) picks them up unchanged; nothing renderer-side needs to know this
 *  restore is disk-sourced rather than in-memory.
 *
 * A session is "restorable" here in the persisted-FILE sense — present in
 * the renderer's array as of the last checkpoint — NOT filtered by its last
 * `status`. Quitting the app kills every live pty, and that exit flips each
 * session to `status: 'done'` moments before the process actually exits
 * (see PtyManager's onExit → the terminal's onPtyExit → updateSession), so
 * 'done' in the persisted file means "was open when the app quit", not "the
 * user closed this". The one signal that actually means "don't resurrect"
 * is the session having been REMOVED from the renderer's array (closed
 * in-app via stopSession) — checkpointSessions only ever mirrors what's
 * still in that array, so a closed session was simply never written here in
 * the first place.
 *
 * Called once, from `app.whenReady()`, right after `createWindow()` so
 * `attachWebContents` is already wired before any respawned session's first
 * bytes arrive. `sessions:restore` awaits `diskRestorePromise` so the
 * renderer's boot-time pull can never race ahead and see a still-empty
 * registry (a claude-resume respawn's grace-period wait can take several
 * seconds).
 */
async function restoreFromDisk(): Promise<DiskRestoreInfo> {
  const persisted = await loadPersistedSessions(app.getPath('userData'));

  // Workspaces (Phase 8.7): loaded/initialized here, not in whenReady(),
  // because a genuinely first-ever registry is named after the first
  // pre-workspace persisted session's repo folder (if any) — this is the
  // one place that knows both `harnessHomeDir` and `persisted.sessions`.
  workspaceRegistry = await initWorkspaceRegistry(harnessHomeDir, persisted.sessions[0]?.cwd);

  if (persisted.sessions.length === 0) return { count: 0, notes: [] };

  const notes: string[] = [];
  const restored: SessionRecord[] = [];

  for (const record of persisted.sessions) {
    const outcome = await respawnSession(ptyManager, record);
    if (!outcome.ok) {
      console.error(`[sessions] could not restore "${record.title}" (${record.cwd})`);
      continue;
    }
    // The respawned process is BRAND NEW (even a `claude --resume` gets a
    // fresh child process) — `tool`/`toolTarget` and `looping` describe the
    // PREVIOUS process's last moment and would otherwise show a stale tool
    // bubble / "looping" badge (with an empty loopDetector streak backing
    // it, so nothing would ever clear it) for a session that hasn't done
    // anything yet this run. `status` is left as persisted: flush() runs
    // BEFORE killAll (see SessionPersistence.flush()'s own comment), so it's
    // the last genuinely-live status, not a quit-induced 'done'.
    //
    // `workspaceId`: a pre-8.7 record has none — resolved to the workspace
    // registry's own default (falling back further only if that id somehow
    // isn't in the registry either, e.g. it was renamed/deleted since) so
    // this migrates for free instead of leaving the field undefined forever.
    restored.push({
      ...record,
      // Arceus (Phase 8.8) belongs to no workspace — restoring him must
      // NOT stamp a concrete id the way an ordinary pre-8.7 record does;
      // that would silently un-global him on the very next relaunch.
      workspaceId: record.isArceus ? undefined : resolveSessionWorkspaceId(record.workspaceId),
      tool: undefined,
      toolTarget: undefined,
      looping: false,
      ...(outcome.fallbackReason ? { error: outcome.fallbackReason } : {})
    });
    if (outcome.fallbackReason) {
      notes.push(`${record.title}: ${outcome.fallbackReason} — opened a plain shell instead.`);
    }
  }

  sessionRegistry = restored;
  lastSelectedId =
    persisted.lastSelectedId && restored.some((s) => s.id === persisted.lastSelectedId)
      ? persisted.lastSelectedId
      : null;

  return { count: restored.length, notes };
}

/** A concrete workspace id for a possibly-missing/stale one — see
 *  `restoreFromDisk`'s own comment on `workspaceId`. */
function resolveSessionWorkspaceId(id: string | undefined): string {
  if (id && workspaceRegistry.workspaces.some((w) => w.id === id)) return id;
  if (workspaceRegistry.workspaces.some((w) => w.id === DEFAULT_WORKSPACE_ID)) return DEFAULT_WORKSPACE_ID;
  return workspaceRegistry.workspaces[0].id;
}

function createWindow(backgroundColor: string): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Pokéharness',
    backgroundColor,
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

  // The macOS traffic-light close button fires `close` directly WITHOUT
  // `before-quit` firing first (that only happens for Cmd+Q / Dock quit /
  // app menu Quit — see the `before-quit` handler below) — on darwin,
  // closing the app's one window doesn't quit the app at all
  // (`window-all-closed` only calls `app.quit()` on non-darwin). Both entry
  // points need their own guard.
  win.on('close', (e) => {
    if (quitConfirmed || !hasLiveSessions()) return;
    e.preventDefault();
    requestQuitConfirmation();
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

/** Kicked off once at launch, right after `createWindow()` — see
 *  `restoreFromDisk`'s own header for why the ordering and the
 *  `sessions:restore` await below both matter. Starts as an already-resolved
 *  empty result so `sessions:restore` never hangs if `whenReady` somehow
 *  never re-assigns it (e.g. a test harness that skips straight to the IPC
 *  layer). */
let diskRestorePromise: Promise<DiskRestoreInfo> = Promise.resolve({ count: 0, notes: [] });
/** Cleared to true once `app:getDiskRestoreInfo` has handed its result to
 *  the renderer — a later call (a plain dev Cmd+R after boot, say) must not
 *  re-toast the same launch-time restore. */
let diskRestoreConsumed = false;

app.whenReady().then(async () => {
  // Independent of any live claude session — the socket must be up before the
  // first spawn (and before any manual shim verification) ever happens.
  hookBridge.ensureFiles();
  hookBridge.start();
  costWatcher.start();
  const appSettings = await loadAppSettings();
  keepAwakeEnabled = appSettings.keepAwake;
  harnessHomeDir = resolveHarnessHomeDir(appSettings);
  await ensureHarnessHome(harnessHomeDir);
  createWindow(resolveWindowBg(appSettings.theme));
  diskRestorePromise = restoreFromDisk();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveWindowBg(appSettings.theme));
  });
});

app.on('window-all-closed', () => {
  // Flush BEFORE killing — see sessionPersistence.ts's SessionPersistence.flush()
  // doc comment for why the order matters.
  sessionPersistence.flush();
  ptyManager.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  // Cmd+Q / Dock quit / app-menu Quit — see the window's own `close` handler
  // in createWindow() for the OTHER entry point (the traffic-light button),
  // which this does not cover. Never fires a second dialog while the sunset
  // ritual itself is mid-flight: the ritual's own final quit routes through
  // the `app:quit` handler below, which sets `quitConfirmed` first.
  if (!quitConfirmed && hasLiveSessions()) {
    e.preventDefault();
    requestQuitConfirmation();
    return;
  }
  sessionPersistence.flush();
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
  sessionPersistence.schedule({ sessions, lastSelectedId: selectedId });
});

// Boot-time pull, for both a crash-triggered reload and a plain dev Cmd+R:
// only sessions whose PTY is still actually alive come back — a session
// whose process had already exited before the reload has nothing live to
// reattach to, so its tab just doesn't reappear (its checkpoint may still be
// sitting in sessionRegistry from before the exit; ptyManager.list() is the
// authority here, not the mirror). Same liveness check for selectedId: no
// point reselecting a tab that isn't coming back.
ipcMain.handle('sessions:restore', async () => {
  // Awaits the launch-time disk restore (a no-op once it's already settled,
  // which is the common case by the time the renderer gets this far) so this
  // never races ahead of `restoreFromDisk` and sees a still-empty registry —
  // see that function's own header.
  await diskRestorePromise;
  const liveIds = new Set(ptyManager.list().map((p) => p.id));
  const sessions = sessionRegistry
    .filter((s) => liveIds.has(s.id))
    .map((session) => ({ session, replay: ptyManager.getReplay(session.id) }));
  const selectedId = lastSelectedId && liveIds.has(lastSelectedId) ? lastSelectedId : null;
  return { sessions, selectedId };
});

// Boot-time pull for the "restored N sessions" toast (Phase 8.5 #1) — see
// `diskRestoreConsumed`'s own comment for why this is clear-on-read.
ipcMain.handle('app:getDiskRestoreInfo', async () => {
  const info = await diskRestorePromise;
  if (diskRestoreConsumed || info.count === 0) return null;
  diskRestoreConsumed = true;
  return info;
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

// ─── General app settings (parity sweep: theme, auto-permission mode,
// keep-awake, recent folders) — same rationale as audio settings above.
ipcMain.handle('appSettings:getSettings', () => loadAppSettings());
ipcMain.handle('appSettings:saveSettings', async (_e, settings: AppSettings) => {
  keepAwakeEnabled = settings.keepAwake;
  syncKeepAwake();

  // Harness home directory (Phase 8.7) — only re-resolves/re-ensures when it
  // actually changed, and never touches anything at the OLD location (the
  // Settings copy says changing this "moves nothing automatically"). Writing
  // the in-memory workspace registry to the NEW location right away is a
  // future write, same as any other mutation below — not a migration of
  // existing files — but it's what keeps "just point future writes at a new
  // folder" from silently losing the workspace list on next launch (that
  // folder has no workspaces.json of its own yet).
  const nextHarnessHomeDir = resolveHarnessHomeDir(settings);
  if (nextHarnessHomeDir !== harnessHomeDir) {
    harnessHomeDir = nextHarnessHomeDir;
    await ensureHarnessHome(harnessHomeDir);
    saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  }

  await saveAppSettings(settings);
  return harnessHomeDir;
});

// ─── Harness home directory (Phase 8.7) ────────────────────────────────────
// Pulled once at boot (main.tsx) to display the CURRENT resolved path in
// Settings even when the setting itself is null (i.e. "use the default") —
// only main can resolve that default (needs os.homedir()).
ipcMain.handle('harnessHome:getResolvedPath', () => harnessHomeDir);

// ─── Arceus (Phase 8.8) ─────────────────────────────────────────────────────
// Ensures agents/arceus/SYSTEM.md exists (seeding it from the template on
// first call only) and returns its CURRENT contents — called fresh on every
// summon, never cached here or renderer-side, so an edit to the file takes
// effect on the very next summon. See arceusPrompt.ts.
ipcMain.handle('arceus:ensureSystemPrompt', () => ensureArceusSystemPrompt(harnessHomeDir));
// Dev-only escape hatch (same shape as config:evolveSeconds/config:shinyOdds
// above): this app must never spawn a REAL claude session for its own
// testing, so summoning Arceus with POKE_ARCEUS_DEV_STANDIN=1 set swaps the
// real `claude --append-system-prompt ...` spawn for a plain shell tagged
// `isArceus` (see the renderer's arceus.ts `summonArceusDevStandin`) —
// everything BUT the real spawn (the cosmos ascent, alpha card, dispatch
// box, persistence, cross-workspace presence) is then exercisable live.
ipcMain.handle('config:arceusDevStandin', () => process.env.POKE_ARCEUS_DEV_STANDIN === '1');

// ─── Workspaces (Phase 8.7) ─────────────────────────────────────────────────
// Every handler here returns the FULL current snapshot (not just the one
// field that changed) so the renderer always hydrates from one authoritative
// source instead of patching its local copy — most load-bearing for delete,
// where main may have to pick a new active workspace itself.
ipcMain.handle('workspaces:list', async () => {
  // workspaceRegistry is populated inside restoreFromDisk() — await the same
  // promise sessions:restore does so this never races ahead of it.
  await diskRestorePromise;
  return workspaceRegistry;
});

ipcMain.handle('workspaces:create', (_e, name: string, primaryFolder: string) => {
  const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const workspace: WorkspaceRecord = {
    id,
    name: name.trim() || basename(primaryFolder.replace(/\/+$/, '')) || 'new garden',
    primaryFolder,
    createdAt: Date.now()
  };
  // A freshly created workspace becomes the active one immediately — there's
  // no reason to create one and keep looking at another.
  workspaceRegistry = { workspaces: [...workspaceRegistry.workspaces, workspace], activeWorkspaceId: id };
  saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  return { ok: true, ...workspaceRegistry };
});

ipcMain.handle('workspaces:rename', (_e, id: string, name: string) => {
  const trimmed = name.trim();
  if (trimmed) {
    workspaceRegistry = {
      ...workspaceRegistry,
      workspaces: workspaceRegistry.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
    };
    saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  }
  return { ok: true, ...workspaceRegistry };
});

ipcMain.handle('workspaces:setActive', (_e, id: string) => {
  if (workspaceRegistry.workspaces.some((w) => w.id === id) && id !== workspaceRegistry.activeWorkspaceId) {
    workspaceRegistry = { ...workspaceRegistry, activeWorkspaceId: id };
    saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  }
  return { ok: true, ...workspaceRegistry };
});

ipcMain.handle('workspaces:delete', (_e, id: string) => {
  if (workspaceRegistry.workspaces.length <= 1) {
    return { ok: false, error: "Can't delete your only workspace.", ...workspaceRegistry };
  }
  // Authoritative liveness check (ptyManager, not merely `status !== 'done'`
  // — same distinction main draws everywhere else it counts live sessions)
  // — the renderer is expected to only ever offer delete once its own view
  // agrees there's nothing live left, but this is the actual guard.
  const liveIds = new Set(ptyManager.list().map((p) => p.id));
  // Arceus (Phase 8.8) is excluded from both checks below: he isn't really
  // "in" whatever workspace his absent workspaceId would otherwise default
  // to, so his liveness must never block a workspace delete, and he must
  // never be dropped as if he were that workspace's orphaned session.
  const hasLiveSession = sessionRegistry.some(
    (s) => !s.isArceus && (s.workspaceId ?? DEFAULT_WORKSPACE_ID) === id && liveIds.has(s.id)
  );
  if (hasLiveSession) {
    return { ok: false, error: 'This workspace still has running sessions.', ...workspaceRegistry };
  }

  // Drop this workspace's persisted-dead sessions (finished-but-still-listed
  // records) along with it, so deleting a workspace never leaves an orphaned
  // entry with a workspaceId nothing in the registry owns anymore.
  sessionRegistry = sessionRegistry.filter((s) => s.isArceus || (s.workspaceId ?? DEFAULT_WORKSPACE_ID) !== id);
  sessionPersistence.schedule({ sessions: sessionRegistry, lastSelectedId });

  const workspaces = workspaceRegistry.workspaces.filter((w) => w.id !== id);
  const activeWorkspaceId =
    workspaceRegistry.activeWorkspaceId === id ? workspaces[0].id : workspaceRegistry.activeWorkspaceId;
  workspaceRegistry = { workspaces, activeWorkspaceId };
  saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  return { ok: true, ...workspaceRegistry };
});

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

// ─── App lifecycle ──────────────────────────────────────────────────────────
// Closing-time sunset ritual (Phase 8.5 Wave B item 2) — called once the
// renderer's own walk/wave/toast/audio-fade sequence finishes (see
// src/renderer/src/closingTime.ts). `before-quit` (above) already kills
// every PTY and stops the hook/cost-watcher servers. This is always a
// CONFIRMED quit (the ritual is its only caller) — sets `quitConfirmed`
// first so it passes through the quit-intercept guard uninterrupted, even if
// sessions are still technically live (the ritual doesn't itself kill them;
// `before-quit`'s existing `ptyManager.killAll()` does).
ipcMain.handle('app:quit', () => {
  quitConfirmed = true;
  app.quit();
});

// "kill it & quit" — the quit dialog's destructive action (parity sweep item
// 2). Bypasses the sunset ritual entirely; `before-quit`'s existing flush +
// killAll still runs.
ipcMain.handle('app:forceQuit', () => {
  quitConfirmed = true;
  app.quit();
});

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
