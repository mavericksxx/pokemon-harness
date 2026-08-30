import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  shell
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { PtyManager } from './pty';
import { AGENT_ID_ENV, DELEGATE_LABEL_ENV, DELEGATE_PARENT_ENV, HookBridge } from './hookBridge';
import { CODEX_HOOKS_NOTICE_TEXT, ensureCodexHooks } from './codexHooks';
import { CostWatcher } from './costWatcher';
import { UsageService } from './usageService';
import { ArceusRelayWatcher } from './arceusRelay';
import { writeArceusRosterFile } from './arceusRosterFile';
import { TaskNotificationWatcher } from './taskNotificationWatcher';
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
import { loadArceusSummonConfig, resetArceusSummonConfig, saveArceusSummonConfig } from './arceusSummonConfig';
import { initWorkspaceRegistry, saveWorkspaceRegistry } from './workspacePersistence';
import { checkForUpdate } from './updateCheck';
import {
  getLogDir,
  getRecentErrorCount,
  initDiagnostics,
  log,
  setDiagnosticsLoggingEnabled
} from './diagnostics';
import { buildDiagnosticsBundle, defaultBundleFilename } from './diagnosticsExport';
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
import type { UpdateCheckResult } from '../shared/updateTypes';
import type { ArceusSummonConfig } from '../shared/arceus';
import type { ExportDiagnosticsResult, LogLevel } from '../shared/diagnosticsTypes';
import type { DelegateSessionSpawned, DelegateSpawnRequest, DelegateSpawnResponse } from '../shared/delegateSpawn';

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

// ─── Local-only diagnostics (BACKLOG item 1) ───────────────────────────────
// Pointed at the DEFAULT harness home right away (settings aren't loaded
// yet at module-load time) so even a very early startup crash gets logged
// somewhere; re-pointed at the resolved (possibly customized) directory once
// settings load in `app.whenReady()` below, and again on every later change
// (see `appSettings:saveSettings`) — same "future writes only, nothing
// already on disk moves" contract harnessHome.ts's own ensureHarnessHome
// follows.
initDiagnostics(defaultHarnessHomeDir());

// Preserve Electron/Node's existing fatal behavior for an uncaught
// exception (an unhandled error here already crashes the process today) —
// this only ADDS a log line before that happens, it must never turn a crash
// into silent continuation.
process.on('uncaughtException', (err) => {
  log('main', 'error', 'uncaughtException', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
// Deliberately does NOT process.exit() here, unlike uncaughtException above:
// whether an unhandled rejection is currently fatal depends on Node's
// --unhandled-rejections flag/version behavior, which isn't something this
// change should second-guess — forcing a hard exit here (skipping
// `before-quit`'s flush/killAll) risks turning a survivable event into lost
// session state, a worse outcome than under-logging. Log only.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : undefined;
  log('main', 'error', 'unhandledRejection', { message: err?.message ?? String(reason), stack: err?.stack });
});

// A GPU/utility/sandbox-helper subprocess dying leaves no trace anywhere
// else — the main process stays alive and this app's own render-process-gone
// handler (createWindow, below) only covers the renderer itself. This is the
// missing witness the garden-ui-crash triage called out for hypothesis 1
// (silent WebGL/GPU context loss): the GPU process crashing/getting killed
// out from under the renderer is exactly what would produce that, so this is
// log-only, not auto-relaunch — see the triage doc for context.
app.on('child-process-gone', (_event, details) => {
  log('main', 'error', 'child-process-gone', details);
});

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
// In-app provider usage-limits panel (BACKLOG "next up" item 1) — off until
// `setEnabled(true)` is called below with the persisted setting; see
// usageService.ts's own header for the "zero credential access while off"
// guarantee this constructor call does NOT itself violate (constructing the
// service performs no I/O).
const usageService = new UsageService(() => mainWindow?.webContents ?? null);
// BACKLOG "next up" item 3 — watches Arceus's own transcript (registered off
// the same onRawPayload hook chained below) for a relay directive and types
// it into the named session's pty. Constructed before `ptyManager` so its
// constructor can close over `ptyManager.write` by reference — see the
// arrow function below, evaluated lazily on first call, not at this line.
const arceusRelay = new ArceusRelayWatcher(
  (id, data) => ptyManager.write(id, data),
  () => sessionRegistry,
  () => mainWindow?.webContents ?? null
);
// Bug B fix (2026-08-29) — see taskNotificationWatcher.ts's own header for
// the real, evidence-backed reason `Stop` alone can no longer be trusted as
// subagent-completion proof for an async `Task`/`Agent` dispatch.
const taskNotificationWatcher = new TaskNotificationWatcher(() => mainWindow?.webContents ?? null);
// Explicit type annotation (unlike `arceusRelay` above, which needs none):
// the delegate-validation callback below returns `boolean`, not `void`, so
// TS must actually resolve `ptyManager`'s type to check it — and `ptyManager`
// in turn is constructed with `hookBridge` as its own first argument, a real
// mutual cycle the `void`-returning callbacks above never triggered. The
// annotation breaks the cycle by fixing `hookBridge`'s type up front.
const hookBridge: HookBridge = new HookBridge(
  app.getPath('userData'),
  () => mainWindow?.webContents ?? null,
  (agentId, transcriptPath) => {
    costWatcher.onHookPayload(agentId, transcriptPath);
    arceusRelay.onHookPayload(agentId, transcriptPath);
    taskNotificationWatcher.onHookPayload(agentId, transcriptPath);
  },
  // External-codex-delegate feature — same forward-reference trick as
  // `arceusRelay` above: `ptyManager` isn't constructed until the next line,
  // but this arrow function only evaluates it when a delegate hook actually
  // arrives, by which point it's long since initialized.
  (id) => ptyManager.hasSession(id),
  // First-class delegate sessions (shared/delegateSpawn.ts) — same
  // forward-reference trick again: this only runs once a validated
  // `delegate/spawn` request arrives, long after `ptyManager`/`mainWindow`
  // are live. Spawns the real `codex exec` pty directly (this process
  // already owns `ptyManager` — no need to round-trip through the renderer's
  // own `pty:spawn` IPC handler, which is the exact same call) and fires a
  // one-way notice so the renderer can catch up (create the terminal, add
  // the roster entry). Deliberately does NOT set DELEGATE_PARENT_ENV/
  // DELEGATE_LABEL_ENV: this pty IS the harness session (identified by its
  // own POKEHARNESS_AGENT_ID below), not an external subprocess the app
  // needs to detect after the fact — setting those too would additionally
  // spawn a redundant roaming delegate battler for it (see hookBridge.ts's
  // `DELEGATE_PARENT_ENV` header). They're stamped as empty strings (not
  // simply omitted) to make that absence unconditional rather than
  // incidental — pty.ts spreads this PROCESS's own env into every spawn, so
  // without this an inherited real value would leak straight through.
  //
  // Codex's own global hook config (codexHooks.ts's `ensureCodexHooks`), if
  // ever trusted, still fires SessionStart/Stop for THIS process too — traced
  // against `CODEX_HOOK_SHIM` (hookBridge.ts): it never reads/stamps
  // `harness_agent_id` at all, so those payloads arrive with
  // `harness_agent_id` absent and `harness_delegate_parent` null (env unset,
  // per above) — `HookBridge.handle` routes them to `handleDelegate`, whose
  // `if (!parentId) return` drops them silently. No corruption, but no
  // signal either — deliberately NOT "fixed" by teaching `CODEX_HOOK_SHIM` to
  // stamp `harness_agent_id` from this same env var: that shim is wired into
  // codex's GLOBAL hooks.json, so it fires for every codex invocation on the
  // machine, including one a user runs manually inside a claude orchestrator
  // pty's own shell — which inherits that pty's `POKEHARNESS_AGENT_ID` too.
  // Stamping it there would misattribute that manual session's own
  // SessionStart/Stop onto the ORCHESTRATOR's `hooks:event:<id>` channel,
  // corrupting its status — exactly what the shim's existing "never stamp"
  // rule (see its own header) prevents. This delegate session doesn't need
  // that channel anyway: `ptyParser.ts` already derives status generically
  // for a non-claude provider from the pty's own output (confirmed live
  // against real codex CLI output — see that file's own citation), and
  // `PtyExit` already flips it to 'done' — the exact two mechanisms every
  // other 'codex'-provider session (created via "+ new agent") already
  // relies on, with nothing delegate-specific needed.
  (req: DelegateSpawnRequest): DelegateSpawnResponse => {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const effort = req.reasoningEffort?.trim() || 'medium';
    const args = [
      'exec',
      '--sandbox',
      'workspace-write',
      '-C',
      req.cwd,
      '-c',
      `model_reasoning_effort=${effort}`,
      '-c',
      'hide_agent_reasoning=true',
      req.prompt
    ];
    const result = ptyManager.spawn({
      id,
      cwd: req.cwd,
      command: 'codex',
      args,
      provider: 'codex',
      env: { [AGENT_ID_ENV]: id, [DELEGATE_PARENT_ENV]: '', [DELEGATE_LABEL_ENV]: '' }
    });
    if (!result.ok) return { ok: false, error: result.error ?? 'spawn failed' };
    const wc = mainWindow?.webContents;
    if (wc && !wc.isDestroyed()) {
      const spawned: DelegateSessionSpawned = {
        id,
        parentAgentId: req.parentAgentId,
        label: req.label,
        cwd: result.cwd ?? req.cwd,
        command: 'codex',
        args
      };
      try {
        wc.send('delegate:sessionSpawned', spawned);
      } catch {
        /* window tore down mid-send */
      }
    }
    return { ok: true, id };
  }
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

// App icon (ship-cut item 2) — macOS reads its dock/Finder icon from the
// packaged bundle's Info.plist (electron-builder's `mac.icon`, build/icon.icns)
// and needs nothing here. This is only for the BrowserWindow itself, which
// matters on Windows/Linux (title bar + taskbar icon) — a no-op on darwin,
// which ignores BrowserWindow's `icon` option. This app has no Windows/Linux
// packaging target yet (item 3 is mac-only), so this only fires in a dev run
// of `npm run dev` on those platforms; `existsSync` guards a repo checkout
// that hasn't run `node build/icon/gen-icon.mjs` yet.
const NON_MAC_WINDOW_ICON = join(process.cwd(), 'build/icon/icon.png');

/** Default zoom — Chromium's native 0 (100%). Was -0.5 (zoomFactor ≈0.91,
 *  one Cmd-minus notch out) as a cheap way to fit ~9% more UI on screen, but
 *  a discriminating screenshot root-caused that to the brand/modal-heading
 *  "squash" bug (BACKLOG.md "smaller known items"): Press Start 2P's pixel
 *  glyphs need integer device pixels, and the 0.91 factor put them on
 *  fractional ones app-wide. The density that -0.5 gave is now baked into
 *  the stylesheet's own base type scale instead (index.css's
 *  `--font-body-md/sm-*` tokens, mirrored in design/tokens.ts's
 *  `type.bodyMd`/`bodySm`), which never touches Press Start 2P's own
 *  integer-only sizes. Applied on every `did-finish-load`, not just the
 *  first — that's the same event that fires after `loadApp`'s crash-
 *  triggered reload (see the `render-process-gone` handler below), so one
 *  listener covers both without extra bookkeeping. The View menu's zoom
 *  items (see `buildApplicationMenu` below) are wired to this same
 *  constant, so Cmd+0 resets to it too. */
const DEFAULT_ZOOM_LEVEL = 0;

/** Custom application menu (BACKLOG.md's "Cmd+0 reset-zoom" item). With
 *  no Menu ever set, Electron supplies its own default macOS menu whose View
 *  submenu's `resetZoom`/`zoomIn`/`zoomOut` roles step Chromium's raw
 *  zoomLevel by whole increments (±1) — coarser than this app's own ±0.5
 *  step, and not routed through the shared `DEFAULT_ZOOM_LEVEL` constant
 *  Cmd+0 resets to below. Replacing the WHOLE application menu just to fix
 *  three items means rebuilding the rest of it too, so this clones the
 *  default macOS structure (app menu, Edit — including the roles that make
 *  Cmd+C/Cmd+V work in ordinary text inputs, which would otherwise regress — View,
 *  Window) via Electron's standard `role`s, and only the three zoom items
 *  get custom `click` handlers. Scoped to just these four menus — the task
 *  this fixes named app/Edit/View/Window specifically, not a full File or
 *  Help menu, so those aren't cloned. Cmd+W (normally a File-menu role on
 *  mac) is kept by giving Window its `close` role instead, rather than
 *  adding a whole extra top-level menu for one item. Built once and
 *  installed in `app.whenReady()` below. The zoom `click` handlers close
 *  over module-level `mainWindow` rather than using the callback's own
 *  `window` argument — that argument is typed `BaseWindow | undefined`
 *  (electron.d.ts), which has no `.webContents`, and this app only ever has
 *  the one window anyway. */
function buildApplicationMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.setZoomLevel(DEFAULT_ZOOM_LEVEL)
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            const wc = mainWindow?.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const wc = mainWindow?.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5);
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'close' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
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
    ...(process.platform !== 'darwin' && existsSync(NON_MAC_WINDOW_ICON)
      ? { icon: NON_MAC_WINDOW_ICON }
      : {}),
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

  // Default zoom (see DEFAULT_ZOOM_LEVEL above) — re-applied after every
  // navigation, including the crash/reload path below, for symmetry with
  // when this constant was non-zero; a fresh navigation already resets
  // zoomLevel to 0 on its own, so this call is a no-op today but keeps the
  // guarantee explicit if the default ever changes again.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(DEFAULT_ZOOM_LEVEL);
    // Fullscreen-aware topbar inset — see the enter/leave-full-screen
    // listeners below. Sent here too (not just on those events) so a fresh
    // navigation — including the render-process-gone auto-reload path —
    // starts with the correct inset instead of assuming windowed.
    win.webContents.send('window:fullscreenChanged', win.isFullScreen());
  });

  // macOS auto-hides the traffic lights in fullscreen, which turns the
  // topbar's traffic-light-safe left inset (index.css's `.topbar` padding)
  // into dead space. Renderer toggles an `is-fullscreen` class off this.
  // `leave-full-screen` in particular can fire mid-teardown (a fullscreen
  // window animates out of fullscreen before closing) — guarded the same
  // way `requestQuitConfirmation`/`runBackgroundUpdateCheck` above are,
  // since an unguarded throw here is a hard app kill (see the
  // `uncaughtException` handler at the top of this file).
  win.on('enter-full-screen', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:fullscreenChanged', true);
  });
  win.on('leave-full-screen', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:fullscreenChanged', false);
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
    log('renderer', 'error', 'render-process-gone', { reason: details.reason, exitCode: details.exitCode });

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

/** External-codex-delegate feature's missing first hop — set once at boot
 *  (below) from `ensureCodexHooks`'s own return value, true only the launch
 *  that actually changed `$CODEX_HOME/hooks.json` (see codexHooks.ts's
 *  header for why every OTHER launch — including one where the merge is
 *  simply gated off — leaves this false, same "consumed once" shape as
 *  `diskRestoreConsumed` above). */
let codexHooksNoticePending = false;

// ─── Tier-1 update check (ship-cut item 4) ─────────────────────────────────
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Runs one check and, only when it finds something actually newer, pushes
 *  it to the renderer for the update toast — never pushes a "no update"
 *  result (the Settings panel's own "check now" round-trip, below, is the
 *  only path that ever sees a negative result). Errors are already
 *  swallowed inside `checkForUpdate` itself; this has nothing further to
 *  catch. */
async function runBackgroundUpdateCheck(): Promise<void> {
  const result = await checkForUpdate();
  if (!result?.available) return;
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('update:available', result);
}

/** Once at launch, then every 24h for as long as the app stays open — no
 *  persisted "next check due" timestamp, so a relaunch always re-checks
 *  immediately (cheap: it's one conditional GET, 304 on no change). */
function scheduleUpdateChecks(): void {
  void runBackgroundUpdateCheck();
  setInterval(() => void runBackgroundUpdateCheck(), UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  // Independent of any live claude session — the socket must be up before the
  // first spawn (and before any manual shim verification) ever happens.
  hookBridge.ensureFiles();
  hookBridge.start();
  // First-class delegate sessions (shared/delegateSpawn.ts) — the exact
  // command an orchestrator runs to spawn one; logged once per launch so it
  // shows up in harness.log rather than needing to be re-derived by hand.
  log('hooks', 'info', 'delegate CLI installed', { command: hookBridge.delegateCliCommand() });
  costWatcher.start();
  arceusRelay.start();
  taskNotificationWatcher.start();
  const appSettings = await loadAppSettings();
  keepAwakeEnabled = appSettings.keepAwake;
hookBridge.setHideStatusline(appSettings.hideClaudeStatusline);
  ptyManager.setShellFallbackEnabled(appSettings.shellFallbackEnabled);
  // External-codex-delegate feature's missing first hop — only when the user
  // hasn't opted out AND codex is actually installed (never write config for
  // a CLI that isn't even on this machine). Gated on `ptyManager.
  // isCommandAvailable`, the exact same PATH-resolution `pty:available`'s IPC
  // handler below uses, so "is codex there" never disagrees between this and
  // an actual spawn attempt.
  if (appSettings.codexDelegateHooks && ptyManager.isCommandAvailable('codex')) {
    codexHooksNoticePending = ensureCodexHooks(hookBridge).changed;
  }
  // Per-provider include/exclude BEFORE the master toggle: setEnabled(true)
  // below can trigger an immediate poll, and that poll's `includedProviders`
  // check needs to already reflect this setting, not the all-included
  // default it starts with (see usageService.ts's `setExcludedProviders`).
  usageService.setExcludedProviders(appSettings.usageExcludedProviders);
  usageService.setEnabled(appSettings.usageLimitsEnabled);
  harnessHomeDir = resolveHarnessHomeDir(appSettings);
  await ensureHarnessHome(harnessHomeDir);
  initDiagnostics(harnessHomeDir);
  setDiagnosticsLoggingEnabled(appSettings.diagnosticsLoggingEnabled);
  // The log file's existence must never depend on the diagnostics toggle
  // (BACKLOG friend-testing readiness) — the "app started" line below is
  // itself an 'info' entry, so it's a no-op while the toggle starts OFF,
  // and this mkdir is what still guarantees `logs/` exists on a fresh
  // install in that case (otherwise the folder is only created lazily on
  // first WRITE — see diagnostics.ts's own comment).
  try {
    const dir = getLogDir();
    if (dir) mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort, same as every other diagnostics I/O guard */
  }
  // One line per launch — also guarantees `logs/` actually exists on disk
  // (the folder is otherwise created lazily on first write) so the Settings
  // panel's "open logs" button isn't a no-op on a fresh install.
  log('main', 'info', 'app started', { appVersion: app.getVersion(), electronVersion: process.versions.electron });
  Menu.setApplicationMenu(buildApplicationMenu());
  createWindow(resolveWindowBg(appSettings.theme));
  diskRestorePromise = restoreFromDisk();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveWindowBg(appSettings.theme));
  });
  scheduleUpdateChecks();
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
usageService.setEnabled(false);
  arceusRelay.stop();
  taskNotificationWatcher.stop();
});

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
function handle(channel: string, fn: IpcListener): void {
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

// ─── PTY IPC ────────────────────────────────────────────────────────────────
handle('pty:spawn', (_e, opts: SpawnPtyOptions) => ptyManager.spawn(opts));
handle('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data));
handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  ptyManager.resize(id, cols, rows)
);
handle('pty:kill', (_e, id: string) => {
  costWatcher.unregisterSession(id);
  taskNotificationWatcher.unregisterSession(id);
  return ptyManager.kill(id);
});
handle('pty:list', () => ptyManager.list());
handle('pty:available', (_e, command: string) => ptyManager.isCommandAvailable(command));
// First-class delegate sessions (shared/delegateSpawn.ts) — the renderer's
// `delegate:sessionSpawned` listener (sessions.ts's `startDelegateSpawnListener`)
// subscribes its terminal to `pty:data:<id>` FIRST, then pulls this to backfill
// whatever the pty already emitted before that subscription existed: unlike
// `sessions:restore`'s replay (captured main-side before any renderer round
// trip even starts), a delegate's pty is already running by the time the
// renderer hears about it at all, so capturing replay before the subscription
// risks a real gap — pulling after risks a few duplicated bytes instead, which
// a live terminal tolerates far better than missing output does.
handle('pty:replay', (_e, id: string) => ptyManager.getReplay(id));

// ─── Crash recovery ─────────────────────────────────────────────────────────
// See the `render-process-gone` handler in createWindow(): the freshly-booted
// renderer calls this once it's actually mounted, rather than main pushing it
// over a one-shot event the renderer might not be listening for yet. A plain
// read, not a destructive one — see pendingCrashInfo's own comment for why.
handle('app:getCrashInfo', () => pendingCrashInfo);

// Renderer → main mirror, called on every session-list or selection change
// (see `startRegistrySync` in src/renderer/src/sessions.ts) — see
// sessionRegistry's own comment above for why this replaces wholesale rather
// than upserting.
handle('sessions:checkpoint', (_e, sessions: SessionRecord[], selectedId: string | null) => {
  notifyStatusTransitions(sessions, selectedId);
  sessionRegistry = sessions;
  lastSelectedId = selectedId;
  // First-class delegate sessions (shared/delegateSpawn.ts) are excluded from
  // DISK persistence only (sessionRegistry above still mirrors them, for
  // notifications/roster file below) — SessionRecord has no field for the
  // prompt that launched one, so a relaunch's `respawnSession`
  // (sessionRespawn.ts) would otherwise respawn a bare, promptless
  // interactive `codex` under a delegate's old card. Silently re-running the
  // ORIGINAL task (if the prompt were persisted instead) would be worse: a
  // delegate still live when the app quits is simply not resurrected, same
  // as a session closed in-app via stopSession never reaching this file.
  sessionPersistence.schedule({
    sessions: sessions.filter((s) => !s.delegateParentId),
    lastSelectedId: selectedId
  });
  // BACKLOG "next up" item 3 — flushes any relay Arceus queued for a target
  // that's now idle (or drops it if that target closed/finished in the
  // meantime). Cheap no-op when nothing is queued.
  arceusRelay.onSessionsChecked(sessions);
  // Regenerates agents/arceus/roster.json (self-serve roster Arceus can read
  // with his own tools) — cheap no-op when nothing roster-relevant changed.
  writeArceusRosterFile(harnessHomeDir, sessions);
});

// Boot-time pull, for both a crash-triggered reload and a plain dev Cmd+R:
// only sessions whose PTY is still actually alive come back — a session
// whose process had already exited before the reload has nothing live to
// reattach to, so its tab just doesn't reappear (its checkpoint may still be
// sitting in sessionRegistry from before the exit; ptyManager.list() is the
// authority here, not the mirror). Same liveness check for selectedId: no
// point reselecting a tab that isn't coming back.
handle('sessions:restore', async () => {
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
handle('app:getDiskRestoreInfo', async () => {
  const info = await diskRestorePromise;
  if (diskRestoreConsumed || info.count === 0) return null;
  diskRestoreConsumed = true;
  return info;
});

// Boot-time pull for the one-time "codex will ask to approve this hook"
// notice — same clear-on-read shape as `app:getDiskRestoreInfo` above (and
// for the same reason: a plain dev Cmd+R after boot must not re-toast it).
handle('app:getCodexHooksNotice', () => {
  if (!codexHooksNoticePending) return null;
  codexHooksNoticePending = false;
  return CODEX_HOOKS_NOTICE_TEXT;
});

// ─── Lazy sprite cache (Phase 3 §2) ────────────────────────────────────────
// Main is the only network and disk actor here: the renderer's CSP has no
// 'unsafe-eval' script-src beyond self and no external connect-src, so it can
// neither fetch Showdown directly nor reach outside contextBridge to touch
// userData. Decoding/re-encoding happens renderer-side (it has a canvas).
handle('sprites:getCached', (_e, id: string, view: SpriteView, shiny: boolean) =>
  getCachedSprite(id, view, shiny)
);
handle('sprites:fetchGif', (_e, id: string, view: SpriteView, shiny: boolean) =>
  fetchSpriteGif(id, view, shiny)
);
handle(
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
handle('audio:getSettings', () => loadAudioSettings());
handle('audio:saveSettings', (_e, settings: AudioSettings) => saveAudioSettings(settings));
// `id` is any mini-player catalog id (musicCatalog.ts), not just the 9
// original curated MusicTrackIds — see musicCache.ts's header.
handle('audio:ensureTrack', (_e, id: string) => ensureMusicTrack(id));
handle('audio:ensureCry', (_e, id: string) => ensureCry(id));
// Background catalog-warm (mini-player generation filter) — see
// musicCache.ts's single-flight coordination.
handle('audio:prefetchTrack', (_e, id: string) => prefetchTrack(id));
handle('audio:cancelPrefetch', () => cancelPrefetch());
handle('audio:cacheStatus', () => getCacheStatus());

// ─── General app settings (parity sweep: theme, auto-permission mode,
// keep-awake, recent folders) — same rationale as audio settings above.
handle('appSettings:getSettings', () => loadAppSettings());
handle('appSettings:saveSettings', async (_e, settings: AppSettings) => {
  keepAwakeEnabled = settings.keepAwake;
  syncKeepAwake();
hookBridge.setHideStatusline(settings.hideClaudeStatusline);
  ptyManager.setShellFallbackEnabled(settings.shellFallbackEnabled);
  // Usage-limits toggle (BACKLOG "next up" item 1) — the ONLY place a save
  // reaches usageService, so flipping it off here is what makes "toggle off
  // = zero credential access" true the instant the user unchecks it, not
  // just on next launch. Per-provider exclusion (feedback: "let the user
  // pick which providers to include") goes first, same ordering rationale as
  // the boot path above.
  usageService.setExcludedProviders(settings.usageExcludedProviders);
  usageService.setEnabled(settings.usageLimitsEnabled);
  // Diagnostics opt-in (BACKLOG friend-testing readiness) — takes effect on
  // this very save, same immediacy as the usage-limits toggle above.
  setDiagnosticsLoggingEnabled(settings.diagnosticsLoggingEnabled);

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
    initDiagnostics(harnessHomeDir); // future log writes only — see its own comment
  }

  await saveAppSettings(settings);
  return harnessHomeDir;
});

// ─── Harness home directory (Phase 8.7) ────────────────────────────────────
// Pulled once at boot (main.tsx) to display the CURRENT resolved path in
// Settings even when the setting itself is null (i.e. "use the default") —
// only main can resolve that default (needs os.homedir()).
handle('harnessHome:getResolvedPath', () => harnessHomeDir);

// ─── Arceus (Phase 8.8) ─────────────────────────────────────────────────────
// Ensures agents/arceus/SYSTEM.md exists (seeding it from the template on
// first call only) and returns its CURRENT contents — called fresh on every
// summon, never cached here or renderer-side, so an edit to the file takes
// effect on the very next summon. See arceusPrompt.ts. Also writes
// roster.json from the current `sessionRegistry` before returning its path,
// so the file the renderer is about to hand Arceus as "always current"
// actually exists at that moment rather than depending on a
// `sessions:checkpoint` having already fired first.
handle('arceus:ensureSystemPrompt', async () => {
  writeArceusRosterFile(harnessHomeDir, sessionRegistry);
  return ensureArceusSystemPrompt(harnessHomeDir);
});
// Dev-only escape hatch (same shape as config:evolveSeconds/config:shinyOdds
// above): this app must never spawn a REAL claude session for its own
// testing, so summoning Arceus with POKE_ARCEUS_DEV_STANDIN=1 set swaps the
// real `claude` spawn (persona typed as his first prompt once ready — see
// shared/arceus.ts) for a plain shell tagged `isArceus` (see the renderer's
// arceus.ts `summonArceusDevStandin`) — everything BUT the real spawn (the
// cosmos ascent, alpha card, dispatch box, persistence, cross-workspace
// presence) is then exercisable live.
handle('config:arceusDevStandin', () => process.env.POKE_ARCEUS_DEV_STANDIN === '1');

// ─── Arceus summon-once (Phase 8.9) ────────────────────────────────────────
// See arceusSummonConfig.ts's own header — this file's mere existence gates
// the setup dialog vs. a silent auto-summon on every later launch.
handle('arceus:loadSummonConfig', () => loadArceusSummonConfig(harnessHomeDir));
handle('arceus:saveSummonConfig', (_e, config: ArceusSummonConfig) =>
  saveArceusSummonConfig(harnessHomeDir, config)
);
handle('arceus:resetSummonConfig', () => resetArceusSummonConfig(harnessHomeDir));

// ─── Workspaces (Phase 8.7) ─────────────────────────────────────────────────
// Every handler here returns the FULL current snapshot (not just the one
// field that changed) so the renderer always hydrates from one authoritative
// source instead of patching its local copy — most load-bearing for delete,
// where main may have to pick a new active workspace itself.
handle('workspaces:list', async () => {
  // workspaceRegistry is populated inside restoreFromDisk() — await the same
  // promise sessions:restore does so this never races ahead of it.
  await diskRestorePromise;
  return workspaceRegistry;
});

handle('workspaces:create', (_e, name: string, primaryFolder: string) => {
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

handle('workspaces:rename', (_e, id: string, name: string) => {
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

handle('workspaces:setActive', (_e, id: string) => {
  if (workspaceRegistry.workspaces.some((w) => w.id === id) && id !== workspaceRegistry.activeWorkspaceId) {
    workspaceRegistry = { ...workspaceRegistry, activeWorkspaceId: id };
    saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  }
  return { ok: true, ...workspaceRegistry };
});

handle('workspaces:delete', (_e, id: string) => {
  if (workspaceRegistry.workspaces.length <= 1) {
    return { ok: false, error: "can't delete your only workspace.", ...workspaceRegistry };
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
    return { ok: false, error: 'this workspace still has running sessions.', ...workspaceRegistry };
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
handle('config:evolveSeconds', () => process.env.POKE_EVOLVE_SECONDS ?? null);
// Phase 5 §1: POKE_SHINY_ODDS overrides the 1-in-N shiny roll (e.g. "1" =
// always shiny, for demos/tests).
handle('config:shinyOdds', () => process.env.POKE_SHINY_ODDS ?? null);
// Phase 8.5 Wave B item 3 §3 — the "plain shell" provider's actual command:
// the user's own interactive shell, which only main can read off $SHELL.
handle('config:defaultShell', () => process.env.SHELL || '/bin/zsh');

// ─── App version + updates (ship-cut item 4) ───────────────────────────────
handle('app:getVersion', () => app.getVersion());
handle('app:openExternal', (_e, url: string) => shell.openExternal(url));
// Settings panel's "check now" — unlike the background 24h check
// (`scheduleUpdateChecks`), this reports its result either way (including
// "you're up to date"), since a user who clicked the button is owed an
// answer, not silence.
handle('update:checkNow', (): Promise<UpdateCheckResult | null> => checkForUpdate());

// ─── Usage limits (BACKLOG "next up" item 1) ───────────────────────────────
// `getSnapshot` is a plain cache read (never triggers a fetch) — the
// renderer's boot-time hydrate and the toggle's own "off" cleanup both use
// it. `refresh` is the popover-open trigger, throttled inside the service
// itself (see usageService.ts's MANUAL_REFRESH_MIN_INTERVAL_MS).
handle('usage:getSnapshot', () => usageService.getSnapshot());
handle('usage:refresh', () => usageService.refreshNow());

// ─── Diagnostics (BACKLOG item 1) — local-only, nothing here leaves the
// machine. ───────────────────────────────────────────────────────────────
// Renderer → main log forwarding: window.onerror/unhandledrejection
// (main.tsx), the counter snapshots (diagnosticsCounters.ts) — all routed
// through the same `log()` hookBridge/pty/uncaughtException use, so the
// Settings panel's "errors this session" count covers renderer-origin
// errors too.
handle('diagnostics:log', (_e, area: string, level: LogLevel, message: string, data?: unknown) =>
  log(area, level, message, data)
);
handle('diagnostics:getInfo', () => ({
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  logDir: getLogDir(),
  recentErrorCount: getRecentErrorCount()
}));
// Settings panel's "open logs" button. `logDir` is only null if
// initDiagnostics somehow never ran — falls back to harnessHomeDir itself
// so the button still does something reasonable rather than silently no-op.
// The `log()` in whenReady() already creates the folder on every normal
// boot, but mkdirSync here too in case nothing has actually logged yet.
handle('diagnostics:openLogs', () => {
  const dir = getLogDir() ?? harnessHomeDir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort — openPath below will just fail visibly if this did too */
  }
  return shell.openPath(dir);
});
// "Export diagnostics bundle" (BACKLOG friend-testing readiness) — a
// dead-simple share flow for a non-technical tester: save-dialog, then
// reveal the finished zip in Finder so "send it to me" is just attaching
// that file. See diagnosticsExport.ts for what's inside and what's redacted.
handle('diagnostics:exportBundle', async (): Promise<ExportDiagnosticsResult> => {
  const win = mainWindow;
  const dialogOpts = {
    defaultPath: defaultBundleFilename(new Date()),
    filters: [{ name: 'Zip', extensions: ['zip'] }]
  };
  const res = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await buildDiagnosticsBundle(res.filePath, await loadAppSettings());
    shell.showItemInFolder(res.filePath);
    return { ok: true, path: res.filePath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log('diagnostics', 'error', 'export bundle failed', { message });
    return { ok: false, error: message };
  }
});

// ─── Terminal settings (Phase 8.5 Wave B item 3) ───────────────────────────
handle('terminal:getSettings', () => loadTerminalSettings());
handle('terminal:saveSettings', (_e, settings: TerminalSettings) =>
  saveTerminalSettings(settings)
);

// ─── Cost & context HUD (Phase 8.5 Wave B item 1) ──────────────────────────
// Test-only escape hatch: registers a session id against an arbitrary
// transcript path, bypassing the real hook payload entirely — this app is
// never allowed to spawn a real `claude` for testing (see hookRouter.ts), so
// verifying the watcher means pointing it at a synthetic transcript from a
// plain bash session instead.
handle('cost:registerTestPath', (_e, agentId: string, transcriptPath: string) =>
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
handle('app:quit', () => {
  quitConfirmed = true;
  app.quit();
});

// "kill it & quit" — the quit dialog's destructive action (parity sweep item
// 2). Bypasses the sunset ritual entirely; `before-quit`'s existing flush +
// killAll still runs.
handle('app:forceQuit', () => {
  quitConfirmed = true;
  app.quit();
});

// ─── Dialog ─────────────────────────────────────────────────────────────────
handle('dialog:chooseFolder', async () => {
  const win = mainWindow;
  const opts = { properties: ['openDirectory', 'createDirectory'] as const };
  const res = win
    ? await dialog.showOpenDialog(win, { properties: [...opts.properties] })
    : await dialog.showOpenDialog({ properties: [...opts.properties] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});
