/** Types shared between main, preload and renderer. Dependency-free. */
import type { AgentProviderId } from './agentProvider';
import type { SessionCostUpdate } from './costTypes';

export interface SpawnPtyOptions {
  id: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** When 'claude', main wires the Claude Code hooks shim (Phase 4 Part A) —
   *  a per-session `--settings` file routing lifecycle hooks over a Unix
   *  domain socket back to this app. Omitted/other providers spawn as before. */
  provider?: AgentProviderId;
}

export interface PtyResult {
  ok: boolean;
  error?: string;
  /** The tilde-expanded absolute cwd main actually spawned into. */
  cwd?: string;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface PtyInfo {
  id: string;
  cwd: string;
  command: string;
  pid: number;
  lastOutputAt: number;
}

/** What a session's walker is doing, derived from the PTY output parser. */
export type SessionStatus = 'starting' | 'idle' | 'working' | 'blocked' | 'done';

/** Named place in the garden a walker heads for. Data-driven — see stations.ts. */
export type StationKind = 'patch' | 'stump' | 'pond' | 'signpost' | 'wander';

export interface NewSessionRequest {
  provider: AgentProviderId;
  cwd: string;
  command: string;
  model?: string;
  title?: string;
  /** Species picked in the dialog — any stage of any dex line. The session
   *  actually hatches at that line's stage 1; defaults to a free line at
   *  random when omitted. */
  pokemon?: string;
  /** Per-session override of the provider's auto-permission-mode setting
   *  (parity sweep item 1) — when true and the provider defines
   *  `autoModeArgs` (agentProvider.ts), those args are appended to the spawn.
   *  Absent/false spawns with no permission-mode flag, same as before this
   *  setting existed. */
  autoMode?: boolean;
}

/** Front or back sprite sheet, for the lazy (unbundled-species) sprite cache. */
export type SpriteView = 'front' | 'back';

/** Sidecar JSON next to a cached, runtime-decoded sheet PNG. */
export interface LazySpriteMeta {
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Milliseconds to hold each frame. */
  durations: number[];
  /** Sheet layout: frames wrap into multiple rows once a single row would
   *  exceed 8192px wide. */
  columns: number;
  rows: number;
}

export interface CachedSprite {
  png: ArrayBuffer;
  meta: LazySpriteMeta;
}

/** Why the renderer process just died, per Electron's `render-process-gone`
 *  (see main/index.ts). Consumed once by the reloaded page's boot sequence
 *  (`consumeCrashInfo`), so it can toast the recovery instead of the garden
 *  just silently reappearing empty. */
export interface RendererCrashInfo {
  reason: string;
  exitCode: number;
}

/** Full session state, mirrored from the renderer's store into main on every
 *  change (`checkpointSessions`) so a renderer crash's reload has something
 *  to rebuild from — main already owns the live PTYs (`PtyManager`), this is
 *  the metadata (species, shiny, accumulated work time...) it can't otherwise
 *  see. Field-for-field the renderer's own `Session` (store.ts), which is
 *  typed as an alias of this. */
export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  command: string;
  provider: AgentProviderId;
  model?: string;
  status: SessionStatus;
  tool?: string;
  toolTarget?: string;
  station: StationKind;
  pokemon: string;
  line: string;
  shiny: boolean;
  workedMs: number;
  accent: number;
  exitCode?: number;
  error?: string;
  createdAt: number;
  /** The `claude` CLI's own session id, captured off the SessionStart hook
   *  payload (Phase 8.5 #1) — lets a disk-persisted claude session respawn
   *  with `claude --resume <id>` after a full app quit/relaunch instead of
   *  starting a fresh conversation. Absent for non-claude sessions and for
   *  any claude session whose hooks haven't fired yet. */
  claudeSessionId?: string;
  /** True once this session's PostToolUse events have repeated the same
   *  tool+target enough times in a row to trip the loop-detection circuit
   *  breaker (Phase 8.5 #3) — the walker/roster card show a distinct
   *  "looping" badge without this becoming a new `SessionStatus` (that would
   *  collide with the `working`/`blocked` semantics every consumer already
   *  keys off). Cleared on any different tool+target or user input. */
  looping?: boolean;
  /** True while this session's walker is napping — a plain-shell session
   *  quiet for 30s+ (Phase 8.5 Wave B item 3), or a claude session between a
   *  PreCompact hook and its post-compact SessionStart (item 4). Additive to
   *  `SessionStatus` on purpose, not a new status value: the visible label
   *  swaps to "napping" while `status` itself is left alone (see
   *  `design/sessionLabel.ts`). */
  napping?: boolean;
  /** Cost & context HUD (Phase 8.5 Wave B item 1) — undefined until the main
   *  process's CostWatcher has parsed at least one transcript line for this
   *  session (claude-provider sessions only; see costWatcher.ts). Absence is
   *  the gauge's own "don't render" signal — no separate provider check
   *  needed in AgentRosterCard. */
  cost?: SessionCostUpdate;
  /** Session-status statusline strip's "↺ changed from <prev>" tick
   *  (session-status feature) — the raw model string this session was
   *  running under just BEFORE its most recent `cost:update` model change,
   *  set by terminalRegistry.ts's `onCostUpdate` handler when it diffs an
   *  incoming update's `model` against `cost.model`'s previous value. Once
   *  set, it persists across further updates that don't change the model
   *  again (the tick stays visible "until next change" per spec) — only a
   *  DIFFERENT subsequent model change overwrites it; the model staying the
   *  same never clears it. Undefined until the first mid-session change. */
  modelChangedFrom?: string;
  /** Which workspace (shared/workspaceTypes.ts) this session belongs to
   *  (Phase 8.7) — additive and optional so pre-8.7 persisted sessions
   *  migrate for free: absent means the implicit `DEFAULT_WORKSPACE_ID`.
   *  Stamped once at creation (renderer's `startSession`) or restore
   *  (main's `restoreFromDisk`) and never changes after — there's no "move
   *  session to another workspace" feature this phase. */
  workspaceId?: string;
  /** True for exactly one session, Arceus (Phase 8.8) — the global
   *  orchestrator. Belongs to no workspace (its `workspaceId` stays absent,
   *  never resolved to the default like an ordinary pre-8.7 record — see
   *  main/index.ts's `restoreFromDisk`), and every per-workspace filter
   *  must widen to include it — see `shared/arceus.ts`'s `isGlobalSession`. */
  isArceus?: boolean;
  /** "keep at this stage — don't evolve" (Phase C follow-up: change-pokemon
   *  stage semantics), set from the roster card's change-pokemon dialog.
   *  `workedMs` keeps accumulating normally either way (battles/bubbles/naps
   *  are all unaffected) — this only gates GardenScene's 1Hz evolution-
   *  ceremony check, the same way it already skips a session outside the
   *  active workspace. Unchecking lets that check fire again on the very
   *  next tick, same "already earned, just deferred" resume as the
   *  workspace case. Absent (undefined) means not frozen. */
  evolutionFrozen?: boolean;
}

/** One session restored on boot (`restoreSessions`): its last-checkpointed
 *  state, plus the still-live PTY's trailing output (`PtyManager.getReplay`)
 *  so the reattached terminal isn't blank until new output arrives. */
export interface RestoredSession {
  session: SessionRecord;
  replay: string;
}

/** Everything `restoreSessions` hands back on boot. `selectedId` is the last
 *  checkpointed selection, or null if it wasn't one of the still-live
 *  sessions (or nothing was selected) — see main/index.ts's `sessions:restore`. */
export interface RestoreSnapshot {
  sessions: RestoredSession[];
  selectedId: string | null;
}

/** Result of the launch-time disk restore (Phase 8.5 #1, `app:getDiskRestoreInfo`)
 *  — how many persisted sessions came back, plus one human-readable note per
 *  session that had to fall back to a plain shell (e.g. an expired
 *  `claude --resume`). Consumed once per launch — see main/index.ts's
 *  `diskRestoreConsumed`. */
export interface DiskRestoreInfo {
  count: number;
  notes: string[];
}
