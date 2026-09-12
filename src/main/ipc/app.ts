import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { handle } from './handle';
import { CODEX_HOOKS_NOTICE_TEXT } from '../codexHooks';
import { loadAppSettings } from '../appSettings';
import { writeArceusRosterFile } from '../arceusRosterFile';
import { ensureArceusSystemPrompt } from '../arceusPrompt';
import { loadArceusSummonConfig, resetArceusSummonConfig, saveArceusSummonConfig } from '../arceusSummonConfig';
import { checkForUpdateNow, getUpdateStatus, installUpdate } from '../autoUpdate';
import { getLogDir, getRecentErrorCount, log } from '../diagnostics';
import { buildDiagnosticsBundle, defaultBundleFilename } from '../diagnosticsExport';
import type { PtyManager } from '../pty';
import type { SessionPersistence } from '../sessionPersistence';
import type { UsageService } from '../usageService';
import type { CostWatcher } from '../costWatcher';
import type { RendererCrashInfo, SessionRecord } from '../../shared/types';
import type { ArceusSummonConfig } from '../../shared/arceus';
import type { WorkspaceSnapshot } from '../../shared/workspaceTypes';
import type { InstallResult, UpdateStatus } from '../../shared/updateTypes';
import type { ExportDiagnosticsResult, LogLevel } from '../../shared/diagnosticsTypes';

export interface AppIpcDeps {
  ptyManager: PtyManager;
  sessionPersistence: SessionPersistence;
  usageService: UsageService;
  costWatcher: CostWatcher;
  getMainWindow: () => BrowserWindow | null;
  getPendingCrashInfo: () => RendererCrashInfo | null;
  getCodexHooksNoticePending: () => boolean;
  setCodexHooksNoticePending: (pending: boolean) => void;
  getClaudeThemeNoticePending: () => string | null;
  setClaudeThemeNoticePending: (notice: string | null) => void;
  openExternalIfSafe: (url: string) => void;
  setQuitConfirmed: (confirmed: boolean) => void;
  setLeaveSessionsRunning: (leaveRunning: boolean) => void;
  getHarnessHomeDir: () => string;
  getSessionRegistry: () => SessionRecord[];
  /** Arceus v2 (docs/arceus-v2-plan.md §3.4) — so `arceus:ensureSystemPrompt`
   *  can write the workspaces registry block into roster.json alongside the
   *  session list, same as `sessions:checkpoint` (ipc/sessions.ts). */
  getWorkspaceRegistry: () => WorkspaceSnapshot;
}

export function registerAppIpc(deps: AppIpcDeps): void {
  const {
    ptyManager,
    sessionPersistence,
    usageService,
    costWatcher,
    getMainWindow,
    getPendingCrashInfo,
    getCodexHooksNoticePending,
    setCodexHooksNoticePending,
    getClaudeThemeNoticePending,
    setClaudeThemeNoticePending,
    openExternalIfSafe,
    setQuitConfirmed,
    setLeaveSessionsRunning,
    getHarnessHomeDir,
    getSessionRegistry,
    getWorkspaceRegistry
  } = deps;

  // ─── Crash recovery ─────────────────────────────────────────────────────────
  // See the `render-process-gone` handler in createWindow(): the freshly-booted
  // renderer calls this once it's actually mounted, rather than main pushing it
  // over a one-shot event the renderer might not be listening for yet. A plain
  // read, not a destructive one — see pendingCrashInfo's own comment for why.
  handle('app:getCrashInfo', () => getPendingCrashInfo());

  // Boot-time pull for the one-time "codex will ask to approve this hook"
  // notice — same clear-on-read shape as `app:getDiskRestoreInfo` above (and
  // for the same reason: a plain dev Cmd+R after boot must not re-toast it).
  handle('app:getCodexHooksNotice', () => {
    if (!getCodexHooksNoticePending()) return null;
    setCodexHooksNoticePending(false);
    return CODEX_HOOKS_NOTICE_TEXT;
  });

  handle('app:getClaudeThemeNotice', () => {
    const notice = getClaudeThemeNoticePending();
    setClaudeThemeNoticePending(null);
    return notice;
  });

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
    writeArceusRosterFile(getHarnessHomeDir(), getSessionRegistry(), getWorkspaceRegistry().workspaces);
    return ensureArceusSystemPrompt(getHarnessHomeDir());
  });
  // Dev-only escape hatch (same shape as config:evolveSeconds/config:shinyOdds
  // above): this app must never spawn a REAL claude session for its own
  // testing, so summoning Arceus with POKE_ARCEUS_DEV_STANDIN=1 set swaps the
  // real `claude` spawn (persona composed into a system-prompt file at spawn
  // — see shared/arceus.ts's buildArceusSystemPrompt) for a plain shell
  // tagged `isArceus` (see the renderer's arceus.ts `summonArceusDevStandin`)
  // — everything BUT the real spawn (the
  // cosmos ascent, alpha card, dispatch box, persistence, cross-workspace
  // presence) is then exercisable live.
  handle('config:arceusDevStandin', () => process.env.POKE_ARCEUS_DEV_STANDIN === '1');

  // ─── Arceus summon-once (Phase 8.9) ────────────────────────────────────────
  // See arceusSummonConfig.ts's own header — this file's mere existence gates
  // the setup dialog vs. a silent auto-summon on every later launch.
  // Provider-aware Arceus (BACKLOG item 1) — a summon.json predating the
  // `provider` field (or one that never named a supported one) falls back to
  // the app's own default provider (settings' "default agent provider" row),
  // not a hardcoded 'claude'; see loadArceusSummonConfig's own comment.
  handle('arceus:loadSummonConfig', async () => {
    const settings = await loadAppSettings();
    return loadArceusSummonConfig(getHarnessHomeDir(), settings.defaultAgentProvider);
  });
  handle('arceus:saveSummonConfig', (_e, config: ArceusSummonConfig) =>
    saveArceusSummonConfig(getHarnessHomeDir(), config)
  );
  handle('arceus:resetSummonConfig', () => resetArceusSummonConfig(getHarnessHomeDir()));

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

  // ─── App version + auto-update ─────────────────────────────────────────────
  handle('app:getVersion', () => app.getVersion());
  handle('app:openExternal', (_e, url: string) => openExternalIfSafe(url));
  // Settings/QuickSettings' "check now" — same channel name as the old
  // tier-1 checker; the result now arrives via the `update:status` push
  // (see autoUpdate.ts) rather than this handler's own return value, so
  // every caller (background 4h tick or this on-demand button) converges on
  // one status object.
  handle('update:checkNow', (): Promise<UpdateStatus> => checkForUpdateNow());
  // "Install" button (state === 'downloaded' only) — attempts
  // `quitAndInstall()`, falling back to revealing the download in Finder.
  handle('update:install', (): Promise<InstallResult> => installUpdate());
  handle('update:getStatus', (): UpdateStatus => getUpdateStatus());

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
    const dir = getLogDir() ?? getHarnessHomeDir();
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
    const win = getMainWindow();
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
  // "kill it & quit" — the quit dialog's destructive action (parity sweep item
  // 2). `before-quit`'s existing flush + killAll still runs.
  handle('app:forceQuit', () => {
    setQuitConfirmed(true);
    app.quit();
  });

  // "leave them running" — the quit dialog's non-destructive action: quits
  // the app but hands each live session's pty master off to a small
  // detached "keeper" process instead of killing it (pty.ts's
  // `detachAllToKeepers`/ptyKeeper.ts), so the underlying CLI keeps running
  // in the background until it finishes on its own; a later relaunch
  // reattaches to it (sessionRespawn.ts's `tryReattach`) instead of
  // resuming/respawning. `before-quit`'s existing flush still runs; its
  // `ptyManager.killAll()` is skipped in favor of the detach, branching on
  // `leaveSessionsRunning` (main/index.ts).
  handle('app:leaveRunningAndQuit', () => {
    setQuitConfirmed(true);
    setLeaveSessionsRunning(true);
    app.quit();
  });

  // "clear & quit" — the quit dialog's most destructive action: quits AND
  // wipes the session registry so the next launch opens to a genuinely empty
  // garden (nothing resumes, nothing respawns). Kill ptys BEFORE flushEmpty —
  // same ordering concern as sessionPersistence.ts's flush() doc comment, but
  // reversed: an exit handler firing during killAll re-checkpoints a
  // non-empty registry, so that must happen before the empty write, not
  // after. `before-quit`'s own `sessionPersistence.flush()` then no-ops
  // safely since `pending` is already null.
  handle('app:wipeGardenAndQuit', () => {
    setQuitConfirmed(true);
    ptyManager.killAll();
    sessionPersistence.flushEmpty();
    app.quit();
  });

  // ─── Dialog ─────────────────────────────────────────────────────────────────
  handle('dialog:chooseFolder', async () => {
    const win = getMainWindow();
    const opts = { properties: ['openDirectory', 'createDirectory'] as const };
    const res = win
      ? await dialog.showOpenDialog(win, { properties: [...opts.properties] })
      : await dialog.showOpenDialog({ properties: [...opts.properties] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
}
