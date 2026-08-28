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
  /** Harness home directory override (Phase 8.7) — the user-visible folder
   *  holding `workspaces.json` and `agents/` (see main/harnessHome.ts). Null
   *  means "use the default" (`~/PokemonHarness`) — only main can resolve
   *  that (needs `os.homedir()`), so the default itself isn't stored here.
   *  Changing this points FUTURE writes at the new folder; it never moves
   *  anything already on disk at the old one. */
  harnessHomeDir: string | null;
/** Suppress the user's global `~/.claude/settings.json` `statusLine` inside
   *  our embedded terminals only (BACKLOG "next up" item 2). Default OFF —
   *  when off, hookBridge.ts's generated per-session settings file omits the
   *  `statusLine` key entirely, so a claude session inherits the user's own
   *  statusline exactly as it would outside this app. Applies on next
   *  session spawn only; live ptys keep whatever they launched with. */
  hideClaudeStatusline: boolean;
  /** In-app provider usage-limits panel (BACKLOG "next up" item 1) — opt-in,
   *  OFF by default. Only while true does main/usageService.ts read the
   *  CLI's own stored credential and call its usage endpoint; flipping this
   *  off tears the service down immediately (zero credential access while
   *  off — see that file's `setEnabled`). Read-only carve-out: never stored,
   *  refreshed, or sent anywhere but the documented usage endpoint. */
  usageLimitsEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  autoModeByProvider: {},
  keepAwake: false,
  recentFolders: [],
  harnessHomeDir: null,
hideClaudeStatusline: false,
  usageLimitsEnabled: false
};
