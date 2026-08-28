/** Types shared between main, preload and renderer for the general app
 *  settings domain (parity sweep): theme, per-provider auto-permission mode,
 *  keep-awake, and the recent-folders quick-pick. One JSON blob, following
 *  the same shape/persistence pattern as `audioTypes.ts` — a handful of
 *  small scalars/lists that don't warrant a file each. Dependency-free
 *  except `AgentProviderId`, matching the rest of shared/. */
import type { AgentProviderId } from './agentProvider';

export type ThemeMode = 'system' | 'light' | 'dark';

/** Cap on the recent-folders quick-pick (item 6) — most-recent-first, deduped. */
export const MAX_RECENT_FOLDERS = 10;

export interface AppSettings {
  /** 'system' (default) follows macOS appearance live; 'light'/'dark' pin it. */
  theme: ThemeMode;
  /** Per-provider default for the auto-permission-mode toggle (item 1) —
   *  only meaningful for providers whose preset defines `autoModeArgs`
   *  (agentProvider.ts). Absent/false means the CLI prompts as normal.
   *  Default OFF for every provider: this app never silently spawns a
   *  session in an autonomous permission mode. */
  autoModeByProvider: Partial<Record<AgentProviderId, boolean>>;
  /** Hold a powerSaveBlocker while any session is live (item 4). Default OFF. */
  keepAwake: boolean;
  /** Most-recently-used working directories, newest first, deduped, capped
   *  at MAX_RECENT_FOLDERS (item 6). */
  recentFolders: string[];
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  autoModeByProvider: {},
  keepAwake: false,
  recentFolders: []
};
