/** Types shared between main, preload and renderer. Dependency-free. */
import type { AgentProviderId } from './agentProvider';

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
  /** True while this session's walker is napping — a plain-shell session
   *  quiet for 30s+ (Phase 8.5 Wave B item 3), or a claude session between a
   *  PreCompact hook and its post-compact SessionStart (item 4). Additive to
   *  `SessionStatus` on purpose, not a new status value: the visible label
   *  swaps to "napping" while `status` itself is left alone (see
   *  `design/sessionLabel.ts`). */
  napping?: boolean;
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
