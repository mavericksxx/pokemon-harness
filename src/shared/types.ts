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
