/** Types shared between main, preload and renderer for the general app
 *  settings domain (parity sweep): theme, per-provider auto-permission mode,
 *  keep-awake, and the recent-folders quick-pick. One JSON blob, following
 *  the same shape/persistence pattern as `audioTypes.ts` — a handful of
 *  small scalars/lists that don't warrant a file each. Dependency-free
 *  except `AgentProviderId` and `UsageProviderId`, matching the rest of
 *  shared/. */
import type { AgentProviderId } from './agentProvider';
import type { UsageProviderId } from './usageTypes';

export type ThemeMode = 'system' | 'light' | 'dark';

/** Cap on the recent-folders quick-pick (item 6) — most-recent-first, deduped. */
export const MAX_RECENT_FOLDERS = 10;

export interface AppSettings {
  /** 'system' (default) follows macOS appearance live; 'light'/'dark' pin it. */
  theme: ThemeMode;
  /** Provider preselected by the New Session dialog. Includes the `shell`
   *  provider, which makes the plain-terminal action a normal provider choice
   *  everywhere else in the session model. */
  defaultAgentProvider: AgentProviderId;
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
  /** BUG/UX fix — when a session's CLI process exits on its own (crash,
   *  `/exit`, ctrl+C), respawn the user's shell in the same tab instead of
   *  leaving it dead (see main/pty.ts's `spawnFallbackShell`). Default ON:
   *  a real terminal always drops you to a shell, this just matches that.
   *  Excludes Arceus (his own resume/re-summon flow owns his pty lifecycle)
   *  regardless of this setting. */
  shellFallbackEnabled: boolean;
  /** In-app provider usage-limits panel (BACKLOG "next up" item 1) — opt-in,
   *  OFF by default. Only while true does main/usageService.ts read the
   *  CLI's own stored credential and call its usage endpoint; flipping this
   *  off tears the service down immediately (zero credential access while
   *  off — see that file's `setEnabled`). Read-only carve-out: never stored,
   *  refreshed, or sent anywhere but the documented usage endpoint. */
  usageLimitsEnabled: boolean;
  /** Per-provider include/exclude for the usage-limits panel (feedback:
   *  "let the user pick which providers to include" — e.g. Claude only, no
   *  Codex). An excluded-list rather than an included-map so a future
   *  provider is included by default without a settings migration (it's
   *  simply absent from this array) — same "no behavior change on upgrade"
   *  guarantee `usageLimitsEnabled`'s default gives existing users, extended
   *  to cover providers added after this field was. Default empty (every
   *  known provider included). Enforced in main/usageService.ts's
   *  `setExcludedProviders`: an excluded provider is never polled — no
   *  credential read, no network call — same hygiene as the master toggle's
   *  off state, just scoped to one provider. */
  usageExcludedProviders: UsageProviderId[];
  /** Which provider's numbers the topbar chip (and the trainer-card popover)
   *  show by default — user request: "i mainly only use claude, so we keep
   *  claude ... once i click to expand i should see by provider whichever
   *  ones i've enabled. there should be an option in settings to set main
   *  provider". 'auto' (default) is today's behavior unchanged: Claude when
   *  it has usable data, else Codex (`autoUsageProvider`, usageWindows.ts)
   *  — so existing users see no change until they pick one. Display-only:
   *  never reaches usageService.ts, so it can't stop a provider from being
   *  polled (that's `usageExcludedProviders`' job). Typed to `UsageProviderId`
   *  rather than every `AgentProviderId` — Cursor/shell never produce a usage
   *  snapshot (see usageTypes.ts), so they'd be permanently-dead options. */
  mainUsageProvider: UsageProviderId | 'auto';
  /** Diagnostics opt-in (BACKLOG friend-testing readiness) — default ON: the
   *  current cohort is the user's own friends beta-testing, and the log
   *  never leaves the machine on its own (see diagnosticsTypes.ts). Off
   *  stops routine/verbose entries (counters snapshots, battle-spawn
   *  chatter) from being written; error-level entries are always captured
   *  regardless of this setting — see main/diagnostics.ts's `log()`. */
  diagnosticsLoggingEnabled: boolean;
  /** External-codex-delegate feature's missing first hop (BACKLOG) — whether
   *  main/index.ts is allowed to merge a pokeharness entry into codex's own
   *  `$CODEX_HOME/hooks.json` (main/codexHooks.ts's `ensureCodexHooks`) so a
   *  delegate `codex exec` can actually reach this app's hook shim. Default
   *  ON: merging is additive and idempotent (existing entries — e.g. another
   *  tool's — are preserved byte-faithfully, never overwritten), and codex
   *  itself still requires a one-time interactive trust approval before the
   *  hook ever runs (see codexHooks.ts's header), so turning this on writes
   *  no live capability by itself. Off skips the merge entirely — no file
   *  write of any kind — for a user who wants zero footprint in their codex
   *  config. No settings-panel toggle yet (BACKLOG); edit app-settings.json
   *  directly to opt out. */
  codexDelegateHooks: boolean;
  /** Render-resolution experiment (diagnostics/experimental, user-requested
   *  A/B toggle) — default OFF (today's behavior: GardenScene.tsx's
   *  `app.init` resolution is `max(devicePixelRatio, 2)`). ON drops it to 1
   *  (`autoDensity` keeps the CSS size unchanged, so the canvas just renders
   *  at a lower backing resolution and the display upscales it — saves GPU
   *  on retina, at the cost of softer pixel-art labels) and applies
   *  `image-rendering: pixelated` to the garden canvas. Takes effect on the
   *  next scene rebuild/app restart, not live — see GardenScene.tsx's own
   *  comment at the `resolution:` line for why. */
  lowResGarden: boolean;
  /** Harness-owned instructions file (HARNESS.md, main/harnessInstructions.ts)
   *  — whether it's appended into every top-level claude/codex session's
   *  argv (see pty.ts's spawn()). Default ON: the file always exists (seeded
   *  at boot) and starts as sane orchestrator guidance, so this only needs
   *  flipping by someone who wants a session with zero extra instructions.
   *  Never applies to a poke-delegate subagent spawn, regardless of this
   *  setting. */
  harnessInstructionsEnabled: boolean;
  /** First-launch welcome dialog (BACKLOG item 2) — false until the user
   *  dismisses it (either button: "summon arceus" or "not now" both record
   *  a choice, so this only ever needs to ask once). Gates two things: the
   *  dialog itself (App.tsx shows it exactly while this is false) and
   *  boot's auto-summon (main.tsx skips `autoSummonArceus()` while false,
   *  even when `agents/arceus/summon.json` already exists — see that call
   *  site's own comment). An EXISTING install's settings file predates this
   *  field, so the defaults-merge in appSettings.ts's `loadAppSettings`
   *  makes it `false` there too and the dialog shows once for them —
   *  intentional (one-time, not a bug): their summon.json survives either
   *  button ("not now" never deletes it), so nothing about their Arceus
   *  setup is lost, they just see the welcome copy once. */
  onboardingDone: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  defaultAgentProvider: 'claude',
  autoModeByProvider: {},
  keepAwake: false,
  recentFolders: [],
  harnessHomeDir: null,
hideClaudeStatusline: false,
  shellFallbackEnabled: true,
  usageLimitsEnabled: false,
  usageExcludedProviders: [],
  mainUsageProvider: 'auto',
  diagnosticsLoggingEnabled: true,
  codexDelegateHooks: true,
  lowResGarden: false,
  harnessInstructionsEnabled: true,
  onboardingDone: false
};
