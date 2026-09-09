import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  shell
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PtyManager } from './pty';
import { registerPtyIpc } from './ipc/pty';
import { registerSessionsIpc } from './ipc/sessions';
import { registerWorkspacesIpc } from './ipc/workspaces';
import { registerSettingsIpc } from './ipc/settings';
import { registerAssetsIpc } from './ipc/assets';
import { registerAppIpc } from './ipc/app';
import { AGENT_ID_ENV, DELEGATE_LABEL_ENV, DELEGATE_PARENT_ENV, HookBridge } from './hookBridge';
import { ensureCodexHooks } from './codexHooks';
import { CostWatcher } from './costWatcher';
import { CostHistoryService } from './costHistory';
import { SessionTitleWatcher } from './sessionTitleWatcher';
import { UsageService } from './usageService';
import { TrayController } from './tray';
import { ArceusRelayWatcher } from './arceusRelay';
import { TaskNotificationWatcher } from './taskNotificationWatcher';
import { loadAudioSettings } from './audioSettings';
import { loadAppSettings, saveAppSettings } from './appSettings';
import { loadPersistedSessions, SessionPersistence } from './sessionPersistence';
import { respawnSession } from './sessionRespawn';
import { ensureClaudeTheme } from './claudeTheme';
import { defaultHarnessHomeDir, ensureHarnessHome, resolveHarnessHomeDir } from './harnessHome';
import { ensureHarnessInstructions, harnessInstructionsPath } from './harnessInstructions';
import { initWorkspaceRegistry, repairWorkspaceFolders, saveWorkspaceRegistry } from './workspacePersistence';
import { checkForUpdate } from './updateCheck';
import { getLogDir, initDiagnostics, log, setDiagnosticsLoggingEnabled } from './diagnostics';
import type {
  DiskRestoreInfo,
  RendererCrashInfo,
  SessionRecord,
  SessionStatus
} from '../shared/types';
import type { AppSettings } from '../shared/appSettingsTypes';
import { DEFAULT_WORKSPACE_ID, type WorkspaceSnapshot } from '../shared/workspaceTypes';
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
//
// Dev/prod userData isolation: dev and packaged builds now get DIFFERENT
// identities ('Pokéharness Dev' vs 'Pokéharness'), not the same one — see
// the single-instance-lock block right below for why. `app.isPackaged` is a
// static property (true only for an actual packaged build, e.g. `npm start`
// after `electron-builder`; false for `electron-vite dev`/`npm run dev`) and
// is safe to read this early — it's derived from the executable's own
// resources layout at process start, not from anything `app.whenReady()` or
// `setName` itself sets up, so there's no ordering dependency on the call
// below.
app.setName(app.isPackaged ? 'Pokéharness' : 'Pokéharness Dev');

// ─── Single-instance lock (hooks.sock clobber bug) ─────────────────────────
// A second launch sharing this SAME identity's userData dir — a second
// packaged-app open, or a second dev run — used to race the first instance
// for hooks.sock: hookBridge.ensureFiles()/start() unconditionally rmSync'd
// and recreated the socket at startup, so the second launch would delete the
// FIRST instance's live socket out from under it, bind its own, then exit
// and leave a dead file at the path — the original process, still listening
// on the now-nameless inode, then got ECONNREFUSED on every hook shim
// connect from then on (no subagent battlers, no tool bubbles/status,
// poke-delegate spawns failing) until a manual restart.
//
// Dev and packaged builds no longer share a userData dir at all (see
// `setName` above) — `app.getPath('userData')` is derived from
// `app.getName()`, so 'Pokéharness' and 'Pokéharness Dev' resolve to two
// separate directories, which in turn gives them separate `hooks.sock`
// paths (hookBridge.ts derives `sockPath` from the `userDataDir` it's
// constructed with), separate sessions.json/app-settings.json, separate
// caches. A dev run and a packaged run can now be up at the same time
// without ever touching the same hooks.sock — there's nothing left for them
// to clobber. What actually prevents the clobber today is that isolation,
// not mutual exclusion.
//
// The lock below still has a job: refusing a SECOND launch of the SAME
// identity (two packaged opens, or two dev runs) — that pair still shares
// one userData dir and one hooks.sock, so the original race is still live
// for it. `requestSingleInstanceLock` keys its lock off
// `app.getPath('userData')`, itself derived from `app.getName()`, so this
// must still run AFTER `setName` above — locking before it would resolve
// every launch (dev or packaged) to the pre-`setName` npm-name userData dir,
// making the lock meaningless for its one remaining job. It's also still
// ahead of anything that actually touches userData in this file
// (hookBridge, sessionPersistence, usageService, ...), so the loser of a
// same-identity race never gets a chance to touch any of it.
//
// `app.quit()` alone only REQUESTS a quit before the app is ready — it
// doesn't stop the ~1400 synchronous lines below from still running to the
// end, which is exactly what "do nothing else" rules out. `process.exit(0)`
// is what actually guarantees that.
//
// `checkSocketHealth()` (hookBridge.ts) plus the on-demand call in pty.ts's
// `spawn()` is this fix's second half — a self-heal for the rare case a
// clobber still happens (e.g. someone kills this lock's holder process hard
// enough that the OS releases the lock without a clean `before-quit`).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

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

// Single-instance lock (see the top of this file) — a second launch attempt
// fires this on the WINNER instead of opening its own window; bring the
// existing one to the front rather than silently dropping the attempt.
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// ─── Quit-intercept dialog (parity sweep item 2) ───────────────────────────
// Set once a quit is CONFIRMED — either the quit dialog's "kill it & quit"
// action (`app:forceQuit`) or its "leave them running" action
// (`app:leaveRunningAndQuit`). While false, both a window close and an app
// quit are intercepted whenever a session is still live, and the renderer is
// asked to show the quit dialog instead.
let quitConfirmed = false;
/** "Leave them running" quit path (QuitDialog.tsx's 3rd action) — set ONLY
 *  by the `app:leaveRunningAndQuit` handler (app.ts), alongside
 *  `quitConfirmed`, same pattern as that flag. `before-quit`'s finalization
 *  block below reads this to decide `ptyManager.detachAllToKeepers()` vs.
 *  its existing `killAll()`. Like `quitConfirmed` above, there's no cancel
 *  path anywhere that resets it back to false — a confirmed quit always
 *  actually quits, so neither flag needs one. */
let leaveSessionsRunning = false;
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
// Picks up Claude Code's own `/rename` slash command (custom-title.json,
// written one directory level below the session's own transcript file —
// see sessionTitleWatcher.ts's header) and pushes it into `session.title`.
// Registered off the same onRawPayload hook chain as costWatcher/
// arceusRelay/taskNotificationWatcher below. Second constructor arg is the
// same forward-reference trick `arceusRelay`'s own `() => sessionRegistry`
// below uses (`sessionRegistry` isn't declared until later in this file, but
// this arrow function only evaluates it once a hook payload actually needs a
// session's current title — long after `sessionRegistry` is live) — scoped
// to just the one field this watcher needs (see its own constructor
// comment).
const sessionTitleWatcher = new SessionTitleWatcher(
  () => mainWindow?.webContents ?? null,
  (agentId) => sessionRegistry.find((s) => s.id === agentId)?.title
);
// In-app provider usage-limits panel (BACKLOG "next up" item 1) — off until
// `setEnabled(true)` is called below with the persisted setting; see
// usageService.ts's own header for the "zero credential access while off"
// guarantee this constructor call does NOT itself violate (constructing the
// service performs no I/O).
const usageService = new UsageService(() => mainWindow?.webContents ?? null);
// Tray popover's cost-history section (issue #17) — a scan of every
// ~/.claude/projects/**/*.jsonl transcript over the last 30 days, cached
// with a TTL (see costHistory.ts's own header). Independent of costWatcher
// above: that one only tracks currently-registered LIVE sessions in memory.
const costHistoryService = new CostHistoryService();
// macOS menu-bar item (issue #17) — custom popover panel, not a native
// `Menu`; see tray.ts's own header for the presentation decision and each
// section's data source. `() => sessionRegistry` is the same forward-
// reference trick `arceusRelay` below uses.
const trayController = new TrayController({
  usageService,
  costHistory: costHistoryService,
  getSessionRegistry: () => sessionRegistry
});
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
  (agentId, transcriptPath, hookEventName, subagentAgentId) => {
    costWatcher.onHookPayload(agentId, transcriptPath, hookEventName, subagentAgentId);
    arceusRelay.onHookPayload(agentId, transcriptPath);
    taskNotificationWatcher.onHookPayload(agentId, transcriptPath, hookEventName, subagentAgentId);
    sessionTitleWatcher.onHookPayload(agentId, transcriptPath, hookEventName, subagentAgentId);
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
    const delegateModel = codexDelegateModel.trim();
    const args = [
      'exec',
      '--sandbox',
      'workspace-write',
      '-C',
      req.cwd,
      ...(delegateModel ? ['-m', delegateModel] : []),
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
      isDelegate: true,
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
// Third arg (GitHub #8) — mirrors `pty:kill`'s own
// `taskNotificationWatcher.unregisterSession(id)` for the one teardown path
// that handler never runs on: a natural exit (the child process dying on its
// own, handled entirely inside pty.ts). Without it, a parent that exits
// naturally while it still has `pending > 0` async subagents keeps the
// watcher's 2s poll cadence alive for that dead session id forever.
const ptyManager = new PtyManager(hookBridge, () => syncKeepAwake(), (id) => {
  taskNotificationWatcher.unregisterSession(id);
  sessionTitleWatcher.unregisterSession(id);
});
let activeTheme: AppSettings['theme'] = 'system';
/** `appSettings.codexDelegateModel` (BACKLOG advisor/delegate model
 *  settings) — set at boot and on every settings save, same module-level
 *  mirror pattern `activeTheme`/`keepAwakeEnabled` above use to reach a
 *  current-settings value into a callback (the delegate-spawn handler wired
 *  into `hookBridge` below) that's registered once at module load, long
 *  before `appSettings` is loaded. Empty string (default) means "don't pass
 *  `-m` at all" — see appSettingsTypes.ts's own field comment for why that's
 *  already Codex's own equivalent of "use the best available model." */
let codexDelegateModel = '';
nativeTheme.on('updated', () => {
  if (activeTheme === 'system') ptyManager.setTerminalAppearance(resolveTerminalAppearance(activeTheme));
});
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
  return resolveTerminalAppearance(theme) === 'dark' ? WINDOW_BG_DARK : WINDOW_BG_LIGHT;
}
function resolveTerminalAppearance(theme: AppSettings['theme']): 'light' | 'dark' {
  return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors) ? 'dark' : 'light';
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
        // `undo`/`redo` deliberately dropped (mute-bypass fix): this app has
        // no undo/redo feature anywhere, and on macOS those two roles map
        // straight to NSResponder's `undo:`/`redo:` — which, with no
        // NSUndoManager to satisfy the request, falls through to a native
        // `NSBeep()` by AppKit design. The terminal's xterm.js view is the
        // worst-hit target: its hidden input is cleared after every keystroke
        // (each one goes straight to the pty instead of accumulating as
        // editable text), so it NEVER has anything to undo — Cmd+Z/Cmd+Shift+Z
        // beeped there on every press, entirely outside this app's own
        // Howler-based audio engine (audioEngine.ts), so no app mute setting
        // could ever silence it. `cut`/`copy`/`paste`/`selectAll` stay: those
        // map to edit commands Chromium actually implements (a no-op selection
        // doesn't fall through to the same native-beep default), and ordinary
        // text inputs elsewhere in the app still need them.
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

// Mirrored from the persisted audio settings once at boot and on every
// renderer save, so native notifications can respect master mute without
// reading the settings file on every checkpoint.
let audioMasterMuted = false;

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
      new Notification({ title: 'pokéharness', body, silent: audioMasterMuted }).show();
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
async function restoreFromDisk(appSettings: AppSettings): Promise<DiskRestoreInfo> {
  const persisted = await loadPersistedSessions(app.getPath('userData'));

  // Workspaces (Phase 8.7): loaded/initialized here, not in whenReady(),
  // because a genuinely first-ever registry is named after the first
  // pre-workspace persisted session's repo folder (if any) — this is the
  // one place that knows both `harnessHomeDir` and `persisted.sessions`.
  workspaceRegistry = await initWorkspaceRegistry(harnessHomeDir, persisted.sessions[0]?.cwd);
  const repaired = repairWorkspaceFolders(workspaceRegistry, persisted.sessions, appSettings.recentFolders);
  if (repaired.repairs.length > 0) {
    workspaceRegistry = repaired.snapshot;
    for (const repair of repaired.repairs) {
      log('main', 'info', 'workspace folder missing — healed', {
        workspaceId: repair.workspaceId,
        oldPath: repair.oldPath,
        newPath: repair.newPath
      });
    }
    saveWorkspaceRegistry(harnessHomeDir, workspaceRegistry);
  }
  if (repaired.recentFolders.length !== appSettings.recentFolders.length) {
    await saveAppSettings({ ...appSettings, recentFolders: repaired.recentFolders });
  }

  if (persisted.sessions.length === 0) return { count: 0, notes: [] };

  const notes: string[] = [];
  const restored: SessionRecord[] = [];

  // Respawned concurrently (was a serial `for await` loop) — `respawnSession`
  // awaits a `RESUME_GRACE_MS` (4s) grace window per claude `--resume`
  // record, which used to make N persisted sessions take up to N×4s before
  // this function (and therefore `sessions:restore`/`workspaces:list`)
  // resolved. `PtyManager.spawn()` itself is effectively synchronous (no
  // internal await before the `pty.spawn()` call, which is itself
  // synchronous) and every per-record resource it touches — the hook
  // shim's settings file, `lastExitCodes`/`delegateExits` cleanup — is keyed
  // by the record's own id, so concurrent respawns can't collide; no pool
  // cap is needed. `Promise.allSettled` (not `Promise.all`) so one record's
  // unexpected rejection can't abort the rest. Results are zipped back
  // against `persisted.sessions` in ORIGINAL order below so the per-record
  // bookkeeping (restored-list order, notes) is unaffected by which respawn
  // actually finished first.
  const outcomes = await Promise.allSettled(
    persisted.sessions.map((record) => respawnSession(ptyManager, record))
  );

  for (let i = 0; i < persisted.sessions.length; i += 1) {
    const record = persisted.sessions[i];
    const settled = outcomes[i];
    if (settled.status === 'rejected') {
      log('main', 'error', 'session respawn threw', {
        id: record.id,
        title: record.title,
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
      });
      console.error(`[sessions] could not restore "${record.title}" (${record.cwd})`);
      continue;
    }
    const outcome = settled.value;
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
      notes.push(`${record.title}: ${outcome.fallbackReason} — opened a shell with pokeharness wiring.`);
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

/** `shell.openExternal` hands `url` to the OS's own URL handler — a
 *  `file:`/`javascript:`/custom-scheme URL there can do far more than open a
 *  browser tab. Used by both the new-window handler below and
 *  `app:openExternal`, so only ever call `shell.openExternal` through this.
 *  `new URL()` throwing (a malformed url) is treated the same as a denied
 *  scheme — deny either way, never let a parse failure fall through. */
function openExternalIfSafe(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    log('main', 'warn', 'openExternal: could not parse url — denied', { url });
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    log('main', 'warn', 'openExternal: denied non-http(s) scheme', { url, protocol });
    return;
  }
  void shell.openExternal(url);
}

function createWindow(backgroundColor: string): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 640, not the old 900 — half of a 13" MacBook's ~1280pt logical width,
    // so the window can still tile into a true 50/50 macOS Split View
    // (issue #2 pt.1). Any higher and the window's own minimum would exceed
    // half that screen's width, which is exactly what Split View was
    // clipping against. The renderer's own narrow-layout collapse
    // (gardenSplit.ts's NARROW_LAYOUT_MAX_PX + effectiveLayout.ts) is what
    // keeps the UI usable, not clipped, once the window gets this small.
    minWidth: 640,
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
    openExternalIfSafe(url);
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
    // Idle-energy pass (2026-09-01) — same "push current state on every
    // fresh navigation" rationale as fullscreenChanged above, so a reload
    // (including the render-process-gone auto-reload path) starts the
    // garden's render-pause state correctly instead of assuming visible.
    win.webContents.send('window:visibilityChanged', win.isVisible());
    // Usage can finish its launch poll before or during renderer boot. Replay
    // the cache after the page load so the startup push cannot be lost; this
    // is push-only and never triggers credential access.
    usageService.replaySnapshot();
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

  // Idle-energy pass (2026-09-01) — the garden ticker's render pass is real
  // GPU/CPU work the OS counts toward "Significant Energy" even while
  // nothing is visible. `document.hidden` (checked in the renderer) already
  // flips correctly on minimize — that's a Chromium page-visibility signal,
  // independent of this window's `backgroundThrottling: false` (which only
  // disables Chromium's timer/rAF THROTTLING, not visibility reporting) —
  // but macOS's Cmd+H "Hide <app>" (wired to the app menu's `role: 'hide'`
  // above) hides every window without necessarily flipping it, so
  // GardenScene's `syncRenderState` needs this main-authoritative signal too.
  // `win.isVisible()` is false for both hidden and minimized, so this and
  // `document.hidden` are redundant on the minimize path and complementary
  // on the hide path — GardenScene ORs them (either saying "hidden" pauses
  // rendering), matching that fail-open design (a dropped/late event here
  // must never be the ONLY thing keeping the garden paused).
  const sendWindowVisibility = (): void => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:visibilityChanged', win.isVisible());
  };
  win.on('hide', sendWindowVisibility);
  win.on('show', sendWindowVisibility);
  win.on('minimize', sendWindowVisibility);
  win.on('restore', sendWindowVisibility);

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
let claudeThemeNoticePending: string | null = null;

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
  costHistoryService.start();
  trayController.init();
  arceusRelay.start();
  taskNotificationWatcher.start();
  sessionTitleWatcher.start();
  const appSettings = await loadAppSettings();
  audioMasterMuted = (await loadAudioSettings()).masterMuted;
  activeTheme = appSettings.theme;
  ptyManager.setTerminalAppearance(resolveTerminalAppearance(appSettings.theme));
  keepAwakeEnabled = appSettings.keepAwake;
  // Restore the last usage snapshot before configuring/enabling the poller or
  // creating the window, so the first renderer replay has real data when the
  // toggle is on. Disabled boots deliberately skip the disk read entirely.
  await usageService.init(appSettings.usageLimitsEnabled);
  // Resolved (and its two awaits settled) BEFORE createWindow() below, on
  // purpose — see the "no await between createWindow() and diskRestorePromise"
  // invariant explained there. harnessHomeDir can be a user-configured
  // network/iCloud path, so these awaits are not guaranteed instant.
  harnessHomeDir = resolveHarnessHomeDir(appSettings);
  await ensureHarnessHome(harnessHomeDir);
  await ensureHarnessInstructions(harnessHomeDir);
  // Perf — create the window here, as soon as the above (theme + usage
  // snapshot + harness home) is ready, instead of after the entire init
  // chain below. show:false + ready-to-show already hide the empty-window
  // flash; this additionally lets the renderer bundle start loading/mounting
  // concurrently with the rest of boot instead of waiting for all of it
  // first. Everything still below either doesn't affect window/renderer
  // readiness (background watchers already started above, diagnostics,
  // update checks) or only needs to be settled by the time a real
  // user-triggered pty spawn can happen (advisor model/shell-fallback
  // wiring, codex hooks) — which in practice is far later than window/bundle
  // load takes.
  //
  // Correctness-critical: nothing between this call and the
  // `diskRestorePromise = restoreFromDisk(appSettings)` reassignment below
  // may contain an `await` (a fire-and-forget async call like
  // `ensureClaudeTheme(...)` below is fine — the yield only matters if WE
  // await it). The renderer's first mount races a `Promise.all` of
  // `sessions:restore`/`app:getDiskRestoreInfo`/`workspaces:list`, all of
  // which await `diskRestorePromise` — until that reassignment runs,
  // `diskRestorePromise` is still the placeholder empty-resolved promise
  // from its module-scope initialization, so an `await` here would open a
  // window for those IPC calls to land on stale/empty data while
  // `restoreFromDisk()` is still respawning PTYs main-side (orphaned
  // processes with no tab). Keeping this stretch synchronous is what
  // guarantees that can't happen.
  createWindow(resolveWindowBg(appSettings.theme));
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
  ptyManager.setHarnessInstructions(appSettings.harnessInstructionsEnabled, harnessInstructionsPath(harnessHomeDir));
  ptyManager.setAdvisorModel(appSettings.advisorModel);
  codexDelegateModel = appSettings.codexDelegateModel;
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
  ensureClaudeTheme(() => {
    // Pull the toast after renderer boot so its listener is guaranteed ready.
    claudeThemeNoticePending = "set claude's theme to auto so it follows pokéharness — change it any time with /theme";
  });
  diskRestorePromise = restoreFromDisk(appSettings);
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
  // which this does not cover. Never fires a second dialog once a quit is
  // already confirmed — `quitConfirmed` is set by the quit dialog's own
  // `app:forceQuit`/`app:leaveRunningAndQuit` handlers before either calls
  // `app.quit()`.
  if (!quitConfirmed && hasLiveSessions()) {
    e.preventDefault();
    requestQuitConfirmation();
    return;
  }
  sessionPersistence.flush();
  if (leaveSessionsRunning) {
    ptyManager.detachAllToKeepers();
  } else {
    ptyManager.killAll();
  }
  hookBridge.stop();
  costWatcher.stop();
  costHistoryService.stop();
  trayController.destroy();
  usageService.shutdown();
  arceusRelay.stop();
  taskNotificationWatcher.stop();
  sessionTitleWatcher.stop();
});

registerPtyIpc({ ptyManager, costWatcher, taskNotificationWatcher, sessionTitleWatcher });

registerSessionsIpc({
  ptyManager,
  sessionPersistence,
  arceusRelay,
  costWatcher,
  taskNotificationWatcher,
  notifyStatusTransitions,
  getSessionRegistry: () => sessionRegistry,
  setSessionRegistry: (sessions) => {
    sessionRegistry = sessions;
  },
  getLastSelectedId: () => lastSelectedId,
  setLastSelectedId: (id) => {
    lastSelectedId = id;
  },
  getHarnessHomeDir: () => harnessHomeDir,
  getDiskRestorePromise: () => diskRestorePromise,
  isDiskRestoreConsumed: () => diskRestoreConsumed,
  setDiskRestoreConsumed: (consumed) => {
    diskRestoreConsumed = consumed;
  }
});

registerAssetsIpc();

registerSettingsIpc({
  ptyManager,
  hookBridge,
  usageService,
  resolveTerminalAppearance,
  syncKeepAwake,
  setActiveTheme: (theme) => {
    activeTheme = theme;
  },
  setKeepAwakeEnabled: (enabled) => {
    keepAwakeEnabled = enabled;
  },
  setCodexDelegateModel: (model) => {
    codexDelegateModel = model;
  },
  getHarnessHomeDir: () => harnessHomeDir,
  setHarnessHomeDir: (dir) => {
    harnessHomeDir = dir;
  },
  getWorkspaceRegistry: () => workspaceRegistry,
  setAudioMasterMuted: (muted) => {
    audioMasterMuted = muted;
  }
});

registerWorkspacesIpc({
  ptyManager,
  sessionPersistence,
  getWorkspaceRegistry: () => workspaceRegistry,
  setWorkspaceRegistry: (snapshot) => {
    workspaceRegistry = snapshot;
  },
  getHarnessHomeDir: () => harnessHomeDir,
  getDiskRestorePromise: () => diskRestorePromise,
  getSessionRegistry: () => sessionRegistry,
  setSessionRegistry: (sessions) => {
    sessionRegistry = sessions;
  },
  getLastSelectedId: () => lastSelectedId
});

registerAppIpc({
  ptyManager,
  sessionPersistence,
  usageService,
  costWatcher,
  getMainWindow: () => mainWindow,
  getPendingCrashInfo: () => pendingCrashInfo,
  getCodexHooksNoticePending: () => codexHooksNoticePending,
  setCodexHooksNoticePending: (pending) => {
    codexHooksNoticePending = pending;
  },
  getClaudeThemeNoticePending: () => claudeThemeNoticePending,
  setClaudeThemeNoticePending: (notice) => {
    claudeThemeNoticePending = notice;
  },
  openExternalIfSafe,
  setQuitConfirmed: (confirmed) => {
    quitConfirmed = confirmed;
  },
  setLeaveSessionsRunning: (leaveRunning) => {
    leaveSessionsRunning = leaveRunning;
  },
  getHarnessHomeDir: () => harnessHomeDir,
  getSessionRegistry: () => sessionRegistry
});
