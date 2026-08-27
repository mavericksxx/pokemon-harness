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
}
