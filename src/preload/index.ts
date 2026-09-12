import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CachedSprite,
  DiskRestoreInfo,
  LazySpriteMeta,
  PtyExit,
  PtyInfo,
  PtyResult,
  RendererCrashInfo,
  RestoreSnapshot,
  SessionRecord,
  SpawnPtyOptions,
  SpriteView
} from '../shared/types';
import type { DelegateHookSignal, HookEvent } from '../shared/hookEvents';
import type { DelegateSessionSpawned } from '../shared/delegateSpawn';
import type { AudioSettings } from '../shared/audioTypes';
import type { TerminalSettings } from '../shared/terminalTypes';
import type { SessionCostUpdate } from '../shared/costTypes';
import type { AppSettings } from '../shared/appSettingsTypes';
import type { WorkspaceMutationResult, WorkspaceSnapshot, WorkspaceUpdate } from '../shared/workspaceTypes';
import type { InstallResult, UpdateStatus } from '../shared/updateTypes';
import type { ArceusSummonConfig } from '../shared/arceus';
import type { PokeAskNotice, PokeRelayDeliveredNotice, PokeSpawnedNotice } from '../shared/pokeTools';
import type { DiagnosticsInfo, ExportDiagnosticsResult, LogLevel } from '../shared/diagnosticsTypes';
import type { UsageSnapshot } from '../shared/usageTypes';

/** The entire privileged surface the renderer gets. Keep it narrow, and keep
 *  this file to `electron` imports only — the preload runs sandboxed. */
const api = {
  spawnPty: (opts: SpawnPtyOptions): Promise<PtyResult> => ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<PtyResult> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<PtyResult> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  killPty: (id: string): Promise<PtyResult> => ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<PtyInfo[]> => ipcRenderer.invoke('pty:list'),
  isCommandAvailable: (command: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:available', command),
  /** First-class delegate sessions (shared/delegateSpawn.ts) — pulled by
   *  sessions.ts's `startDelegateSpawnListener` AFTER it has already
   *  subscribed to `pty:data:<id>` (see that function's own comment for why
   *  the order matters). */
  getPtyReplay: (id: string): Promise<string> => ipcRenderer.invoke('pty:replay', id),
  getPtyExit: (id: string): Promise<PtyExit | null> => ipcRenderer.invoke('pty:exit-info', id),

  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`;
    const listener = (_e: IpcRendererEvent, data: string): void => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id: string, cb: (info: PtyExit) => void): (() => void) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e: IpcRendererEvent, info: PtyExit): void => cb(info);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onHookEvent: (id: string, cb: (evt: HookEvent) => void): (() => void) => {
    const channel = `hooks:event:${id}`;
    const listener = (_e: IpcRendererEvent, evt: HookEvent): void => cb(evt);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** External-codex-delegate feature — a `codex exec` delegate's
   *  SessionStart/Stop (see hookBridge.ts's `handleDelegate`). Single global
   *  channel, same reasoning as `onAsyncSubagentLaunch` below: no one parent
   *  "owns" this the way `onHookEvent`/`onCostUpdate` are scoped per-id. */
  onDelegateHookEvent: (cb: (signal: DelegateHookSignal) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, signal: DelegateHookSignal): void => cb(signal);
    ipcRenderer.on('hooks:delegate', listener);
    return () => ipcRenderer.removeListener('hooks:delegate', listener);
  },
  /** First-class delegate sessions (shared/delegateSpawn.ts) — fires once per
   *  app-spawned `codex exec` pty, right after main has already spawned it
   *  (see main/index.ts's `onDelegateSpawnRequest`). Single global channel,
   *  same reasoning as `onDelegateHookEvent` above — no one parent "owns" it. */
  onDelegateSessionSpawned: (cb: (spawned: DelegateSessionSpawned) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, spawned: DelegateSessionSpawned): void => cb(spawned);
    ipcRenderer.on('delegate:sessionSpawned', listener);
    return () => ipcRenderer.removeListener('delegate:sessionSpawned', listener);
  },
  /** Non-null for a while after a renderer crash's auto-reload — see
   *  main/index.ts's `render-process-gone` handler and `pendingCrashInfo`'s
   *  own comment for why this is a plain (not destructive) read. Pulled on
   *  boot rather than pushed, so there's no race with the renderer
   *  subscribing late. */
  getCrashInfo: (): Promise<RendererCrashInfo | null> => ipcRenderer.invoke('app:getCrashInfo'),

  /** Mirrors the renderer's whole session list (and current selection) into
   *  main, so a renderer crash's reload has something to rebuild from.
   *  Called on every store change — see sessions.ts's `startRegistrySync`. */
  checkpointSessions: (sessions: SessionRecord[], selectedId: string | null): Promise<void> =>
    ipcRenderer.invoke('sessions:checkpoint', sessions, selectedId),
  /** Sessions still alive (their PTY didn't exit) as of the last checkpoint,
   *  plus the last-selected id — called once on boot to re-adopt them after a
   *  crash or a plain reload. */
  restoreSessions: (): Promise<RestoreSnapshot> => ipcRenderer.invoke('sessions:restore'),
  /** Non-null exactly once, right after a launch that respawned at least one
   *  disk-persisted session (Phase 8.5 #1) — see main/index.ts's
   *  `diskRestoreConsumed`. Pulled on boot the same way `getCrashInfo` is. */
  getDiskRestoreInfo: (): Promise<DiskRestoreInfo | null> =>
    ipcRenderer.invoke('app:getDiskRestoreInfo'),
  /** Non-null exactly once, right after a launch that merged a fresh
   *  pokeharness entry into codex's own hooks.json (external-codex-delegate
   *  feature) — see main/codexHooks.ts and main/index.ts's
   *  `codexHooksNoticePending`. Pulled on boot the same way
   *  `getDiskRestoreInfo` above is. */
  getCodexHooksNotice: (): Promise<string | null> => ipcRenderer.invoke('app:getCodexHooksNotice'),
  getClaudeThemeNotice: (): Promise<string | null> => ipcRenderer.invoke('app:getClaudeThemeNotice'),

  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseFolder'),
  resolveTerminalCwd: (candidates: string[]): Promise<string> => ipcRenderer.invoke('paths:resolveTerminalCwd', candidates),

  getCachedSprite: (id: string, view: SpriteView, shiny: boolean): Promise<CachedSprite | null> =>
    ipcRenderer.invoke('sprites:getCached', id, view, shiny),
  fetchSpriteGif: (id: string, view: SpriteView, shiny: boolean, explicitKind?: 'animated' | 'static'): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('sprites:fetchGif', id, view, shiny, explicitKind),
  saveCachedSprite: (
    id: string,
    view: SpriteView,
    shiny: boolean,
    png: ArrayBuffer,
    meta: LazySpriteMeta
  ): Promise<void> => ipcRenderer.invoke('sprites:saveCache', id, view, shiny, png, meta),

  getEvolveSecondsOverride: (): Promise<string | null> => ipcRenderer.invoke('config:evolveSeconds'),
  getShinyOddsOverride: (): Promise<string | null> => ipcRenderer.invoke('config:shinyOdds'),
  getDefaultShell: (): Promise<string> => ipcRenderer.invoke('config:defaultShell'),

  getTerminalSettings: (): Promise<TerminalSettings> => ipcRenderer.invoke('terminal:getSettings'),
  saveTerminalSettings: (settings: TerminalSettings): Promise<void> =>
    ipcRenderer.invoke('terminal:saveSettings', settings),

  onCostUpdate: (id: string, cb: (update: SessionCostUpdate) => void): (() => void) => {
    const channel = `cost:update:${id}`;
    const listener = (_e: IpcRendererEvent, update: SessionCostUpdate): void => cb(update);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** SessionTitleWatcher — a real Claude Code `/rename` picked up from
   *  `custom-title.json` (see main/sessionTitleWatcher.ts's header). Same
   *  per-id channel shape as `onCostUpdate` above. */
  onTitleUpdate: (id: string, cb: (title: string) => void): (() => void) => {
    const channel = `session:title:${id}`;
    const listener = (_e: IpcRendererEvent, title: string): void => cb(title);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** Test-only — see main/index.ts's `cost:registerTestPath` handler. */
  registerCostTestPath: (agentId: string, transcriptPath: string): Promise<void> =>
    ipcRenderer.invoke('cost:registerTestPath', agentId, transcriptPath),

  // ─── Bug B fix (2026-08-29) — see taskNotificationWatcher.ts's header ───
  /** One more async `Task`/`Agent` dispatch outstanding for this parent
   *  session (its transcript's `toolUseResult.isAsync`) — hookRouter.ts uses
   *  this to gate `Stop`-driven battle completion. Single global channel,
   *  same pattern as `onDelegateHookEvent` above, since every listener needs
   *  every parent's events (there's no one owner to scope a per-id channel
   *  to, unlike `onHookEvent`/`onCostUpdate`). */
  onAsyncSubagentLaunch: (cb: (agentId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, agentId: string): void => cb(agentId);
    ipcRenderer.on('battle:asyncLaunch', listener);
    return () => ipcRenderer.removeListener('battle:asyncLaunch', listener);
  },
  /** A real per-subagent completion (the parent transcript's own
   *  `<task-notification>`), whatever its status — hookRouter.ts forwards
   *  this into the existing 'end' battle signal. `taskId` (battler ↔ task-id
   *  correlation fix) is the CLI-internal task-id this completion names, so
   *  BattleManager can retire the exact battler stamped with it instead of
   *  guessing the oldest roaming one. */
  onSubagentTaskNotification: (cb: (agentId: string, taskId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, agentId: string, taskId: string): void => cb(agentId, taskId);
    ipcRenderer.on('battle:subagentTaskNotification', listener);
    return () => ipcRenderer.removeListener('battle:subagentTaskNotification', listener);
  },
  /** Battler ↔ task-id correlation (2026-08-29 fix) — links a `Task` (or
   *  resume/continue) dispatch's `tool_use_id`, known at PreToolUse, to the
   *  CLI-internal task-id `taskNotificationWatcher.ts` reads off the same
   *  async-launch transcript line. See BattleManager.ts's `handleCorrelate`
   *  for what the renderer does with the pair (stamp the spawned battler, or
   *  re-materialize one for a resume). */
  onTaskCorrelated: (cb: (agentId: string, toolUseId: string, taskId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, agentId: string, toolUseId: string, taskId: string): void =>
      cb(agentId, toolUseId, taskId);
    ipcRenderer.on('battle:taskCorrelated', listener);
    return () => ipcRenderer.removeListener('battle:taskCorrelated', listener);
  },

  getAudioSettings: (): Promise<AudioSettings> => ipcRenderer.invoke('audio:getSettings'),
  saveAudioSettings: (settings: AudioSettings): Promise<void> =>
    ipcRenderer.invoke('audio:saveSettings', settings),
  // `id` is any mini-player catalog id (musicCatalog.ts) — includes the 9
  // original curated MusicTrackIds, which are part of that same id space.
  ensureMusicTrack: (id: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('audio:ensureTrack', id),
  ensureCry: (id: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('audio:ensureCry', id),
  prefetchMusicTrack: (id: string): Promise<'cached' | 'ok' | 'busy' | 'failed'> =>
    ipcRenderer.invoke('audio:prefetchTrack', id),
  cancelMusicPrefetch: (): Promise<void> => ipcRenderer.invoke('audio:cancelPrefetch'),
  getMusicCacheStatus: (): Promise<{ bytes: number; cap: number; headroom: number }> =>
    ipcRenderer.invoke('audio:cacheStatus'),

  // ─── General app settings (parity sweep: theme, auto-permission mode,
  // keep-awake, recent folders) — same get/save shape as audio settings above.
  getAppSettings: (): Promise<AppSettings> => ipcRenderer.invoke('appSettings:getSettings'),
  /** Resolves to the (possibly just-changed) harness home directory — see
   *  main/index.ts's `appSettings:saveSettings` handler and harnessHome.ts. */
  saveAppSettings: (settings: AppSettings): Promise<string> =>
    ipcRenderer.invoke('appSettings:saveSettings', settings),

  // ─── Harness home directory (Phase 8.7) ────────────────────────────────
  getHarnessHomePath: (): Promise<string> => ipcRenderer.invoke('harnessHome:getResolvedPath'),

  // ─── Harness-owned instructions file (HARNESS.md) ──────────────────────
  /** Resolved `<harnessHomeDir>/HARNESS.md` path — Settings' "harness
   *  instructions" row displays this in mono. */
  getHarnessInstructionsPath: (): Promise<string> => ipcRenderer.invoke('harness:instructionsPath'),
  /** Settings' "open file" button — `shell.openPath` via IPC, same
   *  fire-and-forget contract as `openLogsFolder` below. */
  openHarnessInstructions: (): Promise<string> => ipcRenderer.invoke('harness:openInstructions'),

  // ─── Arceus (Phase 8.8) ─────────────────────────────────────────────────
  /** Ensures agents/arceus/SYSTEM.md exists (migrating an untouched v1 seed
   *  — see main/arceusPrompt.ts) and returns its current contents + path —
   *  call fresh at every summon, never cache the result. Also (main-side,
   *  before this resolves) writes roster.json fresh, but doesn't hand its
   *  path back over the wire — nothing renderer-side reads that anymore
   *  (pty.ts's `spawn()` resolves it itself at spawn time). */
  ensureArceusSystemPrompt: (): Promise<{ path: string; prompt: string }> =>
    ipcRenderer.invoke('arceus:ensureSystemPrompt'),
  /** Dev-only — see main/index.ts's `config:arceusDevStandin`. */
  getArceusDevStandin: (): Promise<boolean> => ipcRenderer.invoke('config:arceusDevStandin'),

  // ─── Arceus summon-once (Phase 8.9) — arceusSummonConfig.ts ─────────────
  /** Null if Arceus has never been summoned (or the file was reset) — the
   *  signal ArceusRosterCard.tsx's own summon flow uses to decide dialog vs.
   *  silent auto-summon (also read by `autoSummonArceus`, arceus.ts). */
  getArceusSummonConfig: (): Promise<ArceusSummonConfig | null> =>
    ipcRenderer.invoke('arceus:loadSummonConfig'),
  /** Written once, after the FIRST successful summon (SummonArceusDialog) —
   *  never called from the silent auto-summon path itself. */
  saveArceusSummonConfig: (config: ArceusSummonConfig): Promise<void> =>
    ipcRenderer.invoke('arceus:saveSummonConfig', config),
  /** Settings' "reset arceus" action — deletes the saved config, returning
   *  the app to first-run (setup dialog) behavior. */
  resetArceusSummonConfig: (): Promise<void> => ipcRenderer.invoke('arceus:resetSummonConfig'),
  // ─── Arceus v2 (docs/arceus-v2-plan.md §3.2/§7) — poke-ask/poke-spawn/
  // poke-relay. All three are one-way pushes; there is no matching invoke
  // channel because the round trip back is always a plain `writePty` call
  // the renderer makes itself, not a reply over the hooks socket. ─────────
  /** `poke-ask` — shows a picker; the caller answers by injecting into
   *  Arceus's own pty itself (see PokeAskModal.tsx), never through this API. */
  onPokeAsk: (cb: (notice: PokeAskNotice) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, notice: PokeAskNotice): void => cb(notice);
    ipcRenderer.on('poke:ask', listener);
    return () => ipcRenderer.removeListener('poke:ask', listener);
  },
  /** `poke-spawn` — main already spawned the real pty; the renderer's job is
   *  to adopt it as an ordinary session (see sessions.ts's `adoptPokeSpawn`),
   *  same shape as `onDelegateSessionSpawned` above. */
  onPokeSpawn: (cb: (notice: PokeSpawnedNotice) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, notice: PokeSpawnedNotice): void => cb(notice);
    ipcRenderer.on('poke:spawned', listener);
    return () => ipcRenderer.removeListener('poke:spawned', listener);
  },
  /** `poke-relay` — fires once the message is actually written into its
   *  target's pty (may have sat queued until the target went idle); the
   *  renderer stamps its own `lastDispatch` copy for that session. */
  onPokeRelayDelivered: (cb: (notice: PokeRelayDeliveredNotice) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, notice: PokeRelayDeliveredNotice): void => cb(notice);
    ipcRenderer.on('poke:relayDelivered', listener);
    return () => ipcRenderer.removeListener('poke:relayDelivered', listener);
  },

  // ─── Workspaces (Phase 8.7) ─────────────────────────────────────────────
  listWorkspaces: (): Promise<WorkspaceSnapshot> => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (name: string, primaryFolder: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:create', name, primaryFolder),
  renameWorkspace: (id: string, name: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:rename', id, name),
  updateWorkspace: (id: string, fields: WorkspaceUpdate): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:update', id, fields),
  setActiveWorkspace: (id: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:setActive', id),
  deleteWorkspace: (id: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke('workspaces:delete', id),

  // ─── Quit-intercept dialog (parity sweep item 2) ───────────────────────
  /** Fires when main prevented a close/quit because sessions are still live
   *  — `count` is the number of live sessions, main's own authoritative
   *  count (ptyManager.list().length), not recomputed renderer-side. */
  onQuitRequested: (cb: (count: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, count: number): void => cb(count);
    ipcRenderer.on('app:quitRequested', listener);
    return () => ipcRenderer.removeListener('app:quitRequested', listener);
  },
  /** "kill it & quit" — quits immediately. */
  forceQuit: (): Promise<void> => ipcRenderer.invoke('app:forceQuit'),
  /** "quit, leave running" — quits immediately, but detaches every live
   *  session's CLI to a background "keeper" process instead of killing it;
   *  a later relaunch reattaches to whatever's still going. */
  leaveRunningAndQuit: (): Promise<void> => ipcRenderer.invoke('app:leaveRunningAndQuit'),
  /** "clear & quit" — wipes the session registry and quits: the next launch
   *  opens to an empty garden (nothing resumes). */
  wipeGardenAndQuit: (): Promise<void> => ipcRenderer.invoke('app:wipeGardenAndQuit'),

  /** macOS fullscreen state — fires on enter/leave-full-screen plus once per
   *  page load (main/index.ts) so a reload starts with the right topbar
   *  inset. See index.css's `.app.is-fullscreen .topbar`. */
  onFullscreenChange: (cb: (isFullScreen: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, isFullScreen: boolean): void => cb(isFullScreen);
    ipcRenderer.on('window:fullscreenChanged', listener);
    return () => ipcRenderer.removeListener('window:fullscreenChanged', listener);
  },

  /** Window hide/show/minimize/restore (idle-energy pass, 2026-09-01) — see
   *  main/index.ts's `hide`/`show`/`minimize`/`restore` handlers and
   *  GardenScene.tsx's `syncRenderState`, which combines this with its own
   *  `document.visibilitychange` listener to decide when to stop rendering. */
  onWindowVisibilityChange: (cb: (visible: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, visible: boolean): void => cb(visible);
    ipcRenderer.on('window:visibilityChanged', listener);
    return () => ipcRenderer.removeListener('window:visibilityChanged', listener);
  },

  // ─── App version + auto-update ──────────────────────────────────────────
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  /** Settings/QuickSettings' "check now" — fire-and-forget from the
   *  caller's perspective; the result arrives via `onUpdateStatus` below,
   *  same push both this and the background 4h check land on. */
  checkForUpdateNow: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:checkNow'),
  /** "Install" button (state === 'downloaded' only). */
  installUpdate: (): Promise<InstallResult> => ipcRenderer.invoke('update:install'),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:getStatus'),
  /** Pushed on every autoUpdater event (checking/available/downloading/
   *  downloaded/not-available/error) — see main/autoUpdate.ts. */
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: UpdateStatus): void => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  /** Generic main→renderer toast push (hooks.sock self-heal — main/
   *  hookBridge.ts's `checkSocketHealth`) — a one-line text-only channel for
   *  a main-side warning that doesn't already have a dedicated push/pull
   *  path the way update/crash/restore notices do. */
  onToast: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, text: string): void => cb(text);
    ipcRenderer.on('app:toast', listener);
    return () => ipcRenderer.removeListener('app:toast', listener);
  },

  // ─── Diagnostics (BACKLOG item 1) — local-only, nothing here leaves the
  // machine. ─────────────────────────────────────────────────────────────
  logDiagnostic: (area: string, level: LogLevel, message: string, data?: unknown): Promise<void> =>
    ipcRenderer.invoke('diagnostics:log', area, level, message, data),
  getDiagnosticsInfo: (): Promise<DiagnosticsInfo> => ipcRenderer.invoke('diagnostics:getInfo'),
  /** Settings panel's "open logs" button — `shell.openPath` via IPC.
   *  Resolves to '' on success, or an OS error string on failure (Electron's
   *  own shell.openPath contract) — not currently surfaced in the UI, same
   *  as every other fire-and-forget button in this panel. */
  openLogsFolder: (): Promise<string> => ipcRenderer.invoke('diagnostics:openLogs'),
  /** Settings panel's "export diagnostics bundle" button — save-dialog +
   *  reveal-in-Finder happen main-side; see main/diagnosticsExport.ts for
   *  what's inside and what's redacted. */
  exportDiagnosticsBundle: (): Promise<ExportDiagnosticsResult> => ipcRenderer.invoke('diagnostics:exportBundle'),

  // ─── Usage limits (BACKLOG "next up" item 1) — read-only while the
  // settings toggle is on; see main/usageService.ts's header for the "zero
  // credential access while off" guarantee. ───────────────────────────────
  /** Cached read — never triggers a fetch on its own. */
  getUsageSnapshot: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:getSnapshot'),
  /** Popover-open trigger — throttled main-side to once/min; always resolves
   *  to the current snapshot, whether or not this call actually refreshed. */
  refreshUsageNow: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:refresh'),
  onUsageSnapshot: (cb: (snapshot: UsageSnapshot) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, snapshot: UsageSnapshot): void => cb(snapshot);
    ipcRenderer.on('usage:snapshot', listener);
    return () => ipcRenderer.removeListener('usage:snapshot', listener);
  }
};

export type HarnessApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
