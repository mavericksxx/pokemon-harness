/**
 * TrayController — macOS menu-bar (Tray) item, GitHub issue #17.
 *
 * Was a custom popover panel (a transparent, frameless `BrowserWindow`
 * rendering a whole-document HTML string — see git history for
 * trayPopoverHtml.ts/trayPopoverPreload.ts, both deleted by this pass).
 * That design hit an AppKit boundary the popover could never route around:
 * a `BrowserWindow` owned by this app cannot reliably draw over ANOTHER
 * app's native-fullscreen Space, no matter what `setVisibleOnAllWorkspaces`/
 * `setAlwaysOnTop` combination is thrown at it — a window is fundamentally
 * scoped to this app's own Spaces. The user explicitly wants the tray to
 * work while they're in a fullscreen app, which means it can't be a window
 * at all. A native `NSMenu` (via Electron's `Tray.popUpContextMenu`) is NOT
 * a window — it's OS chrome, drawn by the same layer that puts the actual
 * menu bar above every fullscreen Space — so it opens above everything for
 * free, no workspace/fullscreen wiring needed anywhere in this file.
 *
 * SECOND REDESIGN (this pass): the first native-menu version drew each data
 * row as a small icon (an HP-bar or sparkline image) NEXT TO a plain native
 * title string, because that was the only way to get any graphics into an
 * `NSMenuItem` at all. The approved mockup needs tighter control than that
 * split allows — a caption/value pair stacked over a full-width bar, a
 * right-aligned dim-ink value next to a semibold caption, a status dot
 * inline with text — none of which an `NSMenuItem`'s own icon+title layout
 * can produce. "Option A" (the locked-in design decision) draws each ENTIRE
 * row, text included, as one image set as the item's `icon`, with an empty
 * label. `trayRowImages.ts` owns the actual rasterization (a hidden,
 * never-shown `BrowserWindow` running a `<canvas>` 2D context — see that
 * file's own header for why a window is required at all); this file owns
 * the data → `TrayRowSpec` decisions (what each row says, which colors/tones
 * apply) and the scheduling/caching around when to (re-)render and what to
 * show before the first render has ever completed.
 *
 * SYNCHRONOUS OPEN, ASYNCHRONOUS RENDER: `openMenu()` must stay exactly as
 * synchronous as it always was (see "Latency" below) — an `NSMenuItem`
 * image has to already exist at `popUpContextMenu()` time, and rasterizing
 * one is fundamentally an IPC round trip to the hidden window, which can't
 * happen inline without blocking the click. So `openMenu()` never rasterizes
 * anything itself: it reads whatever `TrayController.renderedImages`
 * already holds (built by a PRIOR, background `renderNow()` call — see
 * "Render scheduling" below) and, row by row, uses that row's image if one
 * exists and still matches what THIS open's fresh data would draw, or falls
 * back to a plain native-text row (the old `infoRow` shape) otherwise. That
 * per-row fallback, not an all-or-nothing one, is what keeps a menu opened
 * moments after launch (before the very first render finishes) or moments
 * after a provider's usage windows change shape (before the next render
 * catches up) from ever showing a stale image glued to the wrong row's data
 * — `buildTemplate` compares each row's freshly-computed `TrayRowSpec`
 * against the spec that produced the cached image at that same index
 * (`renderedSpecsJson`), and only trusts the image when they still match.
 *
 * Render scheduling: `scheduleRender()` (debounced `RENDER_DEBOUNCE_MS`,
 * coalescing bursts into one actual render) fires from three places —
 * `init()` (once, at startup), `refreshCaches()` (after the real
 * usage/cost refresh `openMenu()` already kicks off post-popup finishes —
 * see `UsageService`/`CostHistoryService`'s own headers for why THAT is
 * already the right place to catch usage/cost changes), and
 * `nativeTheme`'s `'updated'` event (light/dark switch). Session status
 * counts are a fourth data source this menu draws but that has no
 * "refreshed" signal of its own to hook (`getSessionRegistry` is a plain
 * getter over `main/index.ts`'s own mutable state, not a service with a
 * change event) — wiring one up would mean reaching into index.ts's session
 * bookkeeping, out of this pass's scope ("confined to the tray"). Instead
 * `checkFreshness()`, polled every `FRESHNESS_POLL_MS`, cheaply compares a
 * fingerprint of (session bucket counts, usage/cost cache timestamps, dark
 * mode) against the last one it saw and only calls `scheduleRender()` when
 * something actually changed — the poll itself never rasterizes anything,
 * it just decides whether a render is owed.
 *
 * Data sources, same three as the old popover:
 *  - usage limits   → UsageService.getSnapshot()/refreshNow() — the refresh
 *                      is still throttled (>=60s) per-call, so opening the
 *                      tray menu can't hammer the usage endpoint any harder
 *                      than the in-app chip already doesn't.
 *  - cost history    → CostHistoryService.peek()/getSnapshot() — TTL-cached;
 *                      see that file's own header.
 *  - agent statuses   → the `sessionRegistry` mirror (main/index.ts), passed
 *                      in as a getter (same forward-reference pattern
 *                      `pokeRelay`/`sessionTitleWatcher` already use for the
 *                      same field).
 *
 * NSMenu image-gutter alignment (asked for explicitly, so documented here
 * rather than just applied): AppKit sizes ONE shared leading gutter per
 * `NSMenu` for the `image` property, wide enough for the widest image among
 * ALL of that menu's items — not a per-item gutter. The original version of
 * this file already relied on that (its own comment: "NSMenu sizes the
 * shared image gutter to the widest image among the menu's rows", picking
 * the sparkline's 90pt over the meter's 72pt) while coexisting with the
 * icon-less "Open Pokéharness"/"Quit" rows, which shipped as-is — so the
 * gutter did not visibly break those two rows at a 90pt image width in the
 * ALREADY-SHIPPED v1.20.7 build. This pass raises every image to `294pt`
 * (`trayRowImages.ts`'s `ROW_WIDTH_PT`), over 3x wider, to span the mockup's
 * full row width — whether AppKit still leaves "Open Pokéharness"/"Quit"'s
 * titles flush-left (no image → no gutter reserved for that item) or pushes
 * them right by the full shared gutter width is NOT something this file can
 * verify without actually opening the menu (out of scope for this pass —
 * "do NOT launch the app"). Needs visual confirmation in the running app;
 * see this change's own report for what to check.
 */
import { Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageService } from './usageService';
import type { CostHistoryService } from './costHistory';
import type { SessionRecord } from '../shared/types';
import type { TraySessionCounts } from '../shared/trayTypes';
import type { UsageSnapshot, UsageWindow } from '../shared/usageTypes';
import type { CostHistoryDay, CostHistorySnapshot } from '../shared/costHistoryTypes';
import { log } from './diagnostics';
import { TrayRowRenderer, type TrayRowSpec } from './trayRowImages';

/** 'working'/'idle'/'needs you' bucket, from `SessionRecord.status` — issue
 *  #17's agreed baseline scope. `'done'` sessions are excluded from every
 *  bucket (finished, not a currently-active agent); `'starting'` counts as
 *  idle (not yet working, not blocked). */
function countSessions(sessions: SessionRecord[]): TraySessionCounts {
  const counts: TraySessionCounts = { working: 0, idle: 0, needsYou: 0 };
  for (const s of sessions) {
    if (s.status === 'working') counts.working += 1;
    else if (s.status === 'blocked') counts.needsYou += 1;
    else if (s.status === 'idle' || s.status === 'starting') counts.idle += 1;
  }
  return counts;
}

// ─── Palette ─────────────────────────────────────────────────────────────
// `ink`/`dim`/`track` are new for this pass — the macOS menu's OWN text/HP
// -track colors (approved mockup values), not the app's `design/tokens.ts`
// palette; a status-item menu is OS chrome with an OS-owned background, so
// picking colors from the app's own theme setting instead of the actual
// menu-bar appearance would paint a light palette onto a dark menu, or vice
// versa, whenever they disagree (same reasoning the old header gave for
// reading `nativeTheme` directly rather than the app's theme setting).
// `border`/`done`/`warn`/`danger`/`accent`/`disabled` are unchanged from the
// first native-menu version — hand-matched to design/tokens.ts's dark
// constants and their `*Light` counterparts; kept as-is since this pass
// doesn't touch the tone thresholds or gauge/sparkline colors, only the
// layout and text.
export interface TrayPalette {
  /** Primary text ink — status/caption/label text. */
  ink: string;
  /** Secondary/dim text — header labels, values, reset times. */
  dim: string;
  /** HP-bar empty-segment fill. */
  track: string;
  /** Segment/track outline. */
  border: string;
  /** Low-usage (comfortable) segment fill. */
  done: string;
  /** Mid-usage segment fill. */
  warn: string;
  /** High-usage segment fill. */
  danger: string;
  /** Sparkline bar fill. */
  accent: string;
  /** Zero-cost sparkline bar fill. */
  disabled: string;
}

const DARK_PALETTE: TrayPalette = {
  ink: '#f2f2f7',
  dim: '#98989f',
  track: 'rgba(255,255,255,0.12)',
  border: '#787684',
  done: '#6FB88B',
  warn: '#D8B052',
  danger: '#DF8078',
  accent: '#E8B740',
  disabled: '#313139'
};

const LIGHT_PALETTE: TrayPalette = {
  ink: '#1d1d1f',
  dim: '#86868b',
  track: 'rgba(0,0,0,0.09)',
  border: '#A899B5',
  done: '#5CA97A',
  warn: '#DCAB3C',
  danger: '#D96A62',
  accent: '#DCAB3C',
  disabled: '#E8D9A0'
};

function gaugeTone(percent: number): 'normal' | 'warn' | 'danger' {
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warn';
  return 'normal';
}

// 10, not 14 — at a 4pt-per-segment minimum (the original meter's own
// reasoning, still true at the new full row width), 10 segments keeps each
// fill comfortably readable without the bar looking mushy.
const METER_SEGMENTS = 10;

// ─── Text formatting (unchanged behavior from the deleted popover's own
// inline script, except `fmtUsd`'s thousands separator — new for this pass,
// the mockup's own "$3,496.59" example) ─────────────────────────────────

function capitalizeWords(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** `UsageWindow.label`'s short chip form ('5h' | '7d' | '7d <model>' |
 *  'credits' | ...) to the mockup's short stacked-row caption ('Session' |
 *  'Weekly' | 'Weekly · Fable' | 'Extra credits' | ...) — anything else (a
 *  bare scope name) is title-cased as a reasonable default. */
function shortWindowCaption(label: string): string {
  if (label === '5h') return 'Session';
  if (label === '7d') return 'Weekly';
  if (label === 'credits') return 'Extra credits';
  const scoped = /^7d\s+(.+)$/.exec(label);
  if (scoped) return `Weekly · ${capitalizeWords(scoped[1])}`;
  return capitalizeWords(label);
}

function fmtResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const diffMs = resetsAt - now;
  if (diffMs <= 0) return 'resets soon';
  const totalMin = Math.round(diffMs / 60000);
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 1) return `resets in ${totalMin}m`;
  if (totalHours < 24) return `resets in ${totalHours}h ${totalMin % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `resets in ${days}d ${totalHours % 24}h`;
}

function fmtAgo(updatedAt: number | undefined, now: number): string {
  if (!updatedAt) return '';
  const diffMin = Math.max(0, Math.round((now - updatedAt) / 60000));
  return diffMin <= 0 ? 'as of just now' : `as of ${diffMin}m ago`;
}

function fmtUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTokens(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** "claude-sonnet-5" → "sonnet-5" — the mockup's "Most used" row drops both
 *  the provider prefix and (unlike the old design) the trailing token count. */
function stripModelPrefix(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI' };

// ─── Row entries — the single source of truth for both what gets rendered
// (the `TrayRowSpec`s handed to `TrayRowRenderer.render`) and what the final
// menu template looks like (each entry's own `fallbackText` is the plain
// native-text row shown until/unless a matching rendered image exists) ────

type TrayEntry = { type: 'separator' } | { type: 'row'; spec: TrayRowSpec; fallbackText: string; tooltip: string };

function rowEntry(spec: TrayRowSpec, fallbackText: string): TrayEntry {
  return { type: 'row', spec, fallbackText, tooltip: fallbackText };
}

function headerEntry(left: string, right: string): TrayEntry {
  return rowEntry({ kind: 'header', left, right }, [left, right].filter(Boolean).join(' — '));
}

function textEntry(text: string): TrayEntry {
  return rowEntry({ kind: 'text', text }, text);
}

function statEntry(label: string, value: string): TrayEntry {
  return rowEntry({ kind: 'stat', label, value }, `${label} — ${value}`);
}

function statusEntry(sessions: TraySessionCounts, palette: TrayPalette): TrayEntry {
  const leftText = `${sessions.working} working · ${sessions.idle} idle`;
  const rightText = `${sessions.needsYou} need you`;
  const dotColor = sessions.working > 0 ? palette.done : palette.dim;
  return rowEntry({ kind: 'status', dotColor, leftText, rightText }, `${leftText} · ${rightText}`);
}

/** One `UsageWindow` → one stacked caption/value(+bar) row, or (for
 *  `balanceOnly` rows — Codex's credit balance, no known max) a single
 *  caption/value line with no bar, same as the deleted popover's reasoning:
 *  there's no percentage to draw a gauge against. */
function windowEntry(w: UsageWindow, now: number, palette: TrayPalette): TrayEntry {
  const caption = shortWindowCaption(w.label);
  if (w.balanceOnly) {
    const value = w.balanceText ?? '';
    return rowEntry({ kind: 'window', caption, value, bar: null }, value ? `${caption} — ${value}` : caption);
  }
  const percent = w.spend ? (w.spend.limitCents > 0 ? (w.spend.usedCents / w.spend.limitCents) * 100 : 0) : w.usedPercent;
  const bits: string[] = [];
  bits.push(w.spend ? `${fmtUsd(w.spend.usedCents / 100)} / ${fmtUsd(w.spend.limitCents / 100)} ${w.spend.currency}` : `${Math.round(w.usedPercent)}%`);
  const resetText = fmtResetIn(w.resetsAt, now);
  if (resetText) bits.push(resetText);
  const value = bits.join(' · ');
  const clamped = Math.max(0, Math.min(100, percent));
  const filledSegments = Math.round((clamped / 100) * METER_SEGMENTS);
  const tone = gaugeTone(percent);
  const fillColor = tone === 'danger' ? palette.danger : tone === 'warn' ? palette.warn : palette.done;
  const spec: TrayRowSpec = { kind: 'window', caption, value, bar: { filledSegments, totalSegments: METER_SEGMENTS, fillColor } };
  return rowEntry(spec, `${caption} — ${value}`);
}

function sparklineEntry(days: CostHistoryDay[], palette: TrayPalette): TrayEntry {
  const max = days.reduce((m, d) => Math.max(m, d.costUsd), 0);
  const bars = days.map((d) => {
    const isZero = d.costUsd <= 0;
    const heightFrac = isZero ? 0.08 : Math.max(0.12, max > 0 ? d.costUsd / max : 0);
    return { heightFrac, color: isZero ? palette.disabled : palette.accent };
  });
  return rowEntry({ kind: 'sparkline', bars }, '30-day trend');
}

/** The "Limits" section's rows — an unconditional header row ("Limits" left,
 *  the first provider's name right, per the mockup) followed by that
 *  provider's window rows, then one more header (empty left, that
 *  provider's name right) + windows per ADDITIONAL provider — unlike the
 *  first native-menu version, which only inserted a provider sub-header at
 *  all once there were 2+ providers. */
function buildLimitsEntries(usage: UsageSnapshot, palette: TrayPalette): TrayEntry[] {
  if (!usage.enabled) return [headerEntry('Limits', ''), textEntry('usage limits are off — enable them in settings')];
  if (usage.providers.length === 0) return [headerEntry('Limits', ''), textEntry('no usage data yet')];
  const now = Date.now();
  const entries: TrayEntry[] = [];
  usage.providers.forEach((p, i) => {
    const providerLabel = PROVIDER_LABEL[p.provider] ?? p.provider;
    entries.push(headerEntry(i === 0 ? 'Limits' : '', providerLabel));
    if (p.state === 'ok' || p.state === 'stale') {
      if (p.state === 'stale') {
        // `message`/`fmtAgo` can each independently be empty — join only the
        // non-empty ones so a missing one never leaves a dangling leading or
        // trailing " · ".
        const bits = [p.message, fmtAgo(p.updatedAt, now)].filter((bit): bit is string => Boolean(bit));
        if (bits.length > 0) entries.push(textEntry(bits.join(' · ')));
      }
      if (p.windows.length === 0) entries.push(textEntry('no usage windows reported'));
      for (const w of p.windows) entries.push(windowEntry(w, now, palette));
    } else {
      entries.push(textEntry(p.message ?? 'usage unavailable'));
    }
  });
  return entries;
}

/** The "Cost" section's rows — an unconditional "Cost"/"30 days" header
 *  (unlike "Limits", this one never depends on whether there's data),
 *  sparkline, then the four stats the mockup keeps (today, 30-day total,
 *  latest turn, top model). `hasAttempted`
 *  (`CostHistoryService.hasAttempted()`) disambiguates the empty-`days`
 *  case: `peek()` returns the same zeroed snapshot whether the first scan
 *  just hasn't finished yet OR every attempt so far has failed
 *  (`CostHistoryService`'s own `emptySnapshot()` fallback covers both), and
 *  those read very differently to a user — "computing…" implies it'll
 *  resolve on its own, which isn't true for the second case. */
function buildCostEntries(cost: CostHistorySnapshot, hasAttempted: boolean, palette: TrayPalette): TrayEntry[] {
  const entries: TrayEntry[] = [headerEntry('Cost', '30 days')];
  if (cost.days.length === 0) {
    entries.push(textEntry(hasAttempted ? 'cost history unavailable' : 'computing…'));
    return entries;
  }
  entries.push(sparklineEntry(cost.days, palette));
  entries.push(statEntry('Today', fmtUsd(cost.todayCostUsd)));
  entries.push(statEntry('30-day total', fmtUsd(cost.last30dCostUsd)));
  entries.push(statEntry('Last turn', cost.latestTurnTokens == null ? '—' : `${fmtTokens(cost.latestTurnTokens)} tokens`));
  if (cost.topModel) entries.push(statEntry('Most used', stripModelPrefix(cost.topModel.model)));
  return entries;
}

function buildTrayEntries(
  usage: UsageSnapshot,
  cost: CostHistorySnapshot,
  hasAttempted: boolean,
  sessions: TraySessionCounts,
  palette: TrayPalette
): TrayEntry[] {
  return [
    statusEntry(sessions, palette),
    { type: 'separator' },
    ...buildLimitsEntries(usage, palette),
    { type: 'separator' },
    ...buildCostEntries(cost, hasAttempted, palette)
  ];
}

/** A non-interactive, data-carrying menu row. Must stay `enabled` even
 *  though a click does nothing: AppKit dims BOTH a disabled `NSMenuItem`'s
 *  title text and its attached image, and Electron's `Menu`/`MenuItem` API
 *  exposes no way to get non-dimmed, genuinely inert menu text — that would
 *  need a custom `NSMenuItem.view`, which Electron doesn't surface.
 *  "Enabled with a no-op click handler" is the closest approximation
 *  available. `tooltip`, when given, is set as BOTH `toolTip` (hover text)
 *  and `accessibilityLabel` (VoiceOver) — the icon-only row (empty `label`)
 *  otherwise has no accessible text at all. There is still no way to make
 *  VoiceOver read the row's actual on-screen text short of a real
 *  `NSMenuItem.view`; `accessibilityLabel` is the closest available
 *  substitute, not a full fix. */
function infoRow(label: string, icon?: NativeImage, tooltip?: string): MenuItemConstructorOptions {
  const item: MenuItemConstructorOptions = { label, click: () => {} };
  if (icon) item.icon = icon;
  if (tooltip) {
    item.toolTip = tooltip;
    item.accessibilityLabel = tooltip;
  }
  return item;
}

export interface TrayControllerDeps {
  usageService: UsageService;
  costHistory: CostHistoryService;
  getSessionRegistry: () => SessionRecord[];
  /** "Open Pokéharness" menu item — the popover never needed an explicit
   *  "show the app" action (it WAS the visible surface); a menu is
   *  read-only, so this is new. Wired to the same `ensureWindowOpen()`
   *  index.ts already uses for the Dock icon / second-instance case. */
  onOpenWindow: () => void;
}

/** How often bursts of `scheduleRender()` calls get coalesced into one
 *  actual render — "coalesce renders" (task spec), so a rapid sequence of
 *  triggers (e.g. `refreshCaches()` landing right as `nativeTheme` also
 *  fires) only pays for one round trip to the hidden window. */
const RENDER_DEBOUNCE_MS = 250;

/** How often `checkFreshness()` re-checks whether anything worth
 *  re-rendering has changed since the last render — see this file's own
 *  header ("Render scheduling") for why session counts need a poll at all
 *  rather than an event. Cheap on every tick that finds nothing changed
 *  (an array scan + a handful of number/string comparisons), so a few
 *  seconds of cadence costs nothing while staying well under "the status
 *  row looks stale" territory. */
const FRESHNESS_POLL_MS = 2000;

export class TrayController {
  private tray: Tray | null = null;
  private readonly rowRenderer = new TrayRowRenderer();
  /** Parallel to `renderedSpecsJson` below — `renderedImages[i]` is only
   *  trusted for row `i` of a fresh `buildTemplate()` pass when
   *  `renderedSpecsJson[i]` still matches that row's freshly-computed spec
   *  (see this file's own header, "SYNCHRONOUS OPEN, ASYNCHRONOUS RENDER"). */
  private renderedImages: NativeImage[] = [];
  private renderedSpecsJson: string[] = [];
  private pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private lastFingerprint = '';
  /** Guards against a slower, superseded `renderNow()` call overwriting a
   *  faster, later one's result if two ever overlap (shouldn't happen given
   *  the debounce above always clears any still-pending timer first, but
   *  cheap insurance against a future scheduling change reintroducing the
   *  race). */
  private renderGeneration = 0;
  private readonly onThemeUpdated = () => this.scheduleRender();

  constructor(private deps: TrayControllerDeps) {}

  /** Creates the tray icon (idempotent — a second call is a no-op). Safe to
   *  call even where `Tray` isn't meaningfully supported; Electron no-ops
   *  gracefully on unsupported platforms rather than throwing. Skips
   *  creating the `Tray` entirely if the icon image failed to load (e.g.
   *  `extraResources` didn't land `tray/pokeballTemplate.png` in a packaged
   *  build) — an invisible-but-clickable blank slot in the real macOS menu
   *  bar would be worse than no tray item at all. */
  init(): void {
    if (this.tray) return;
    const icon = loadTemplateIcon();
    if (icon.isEmpty()) {
      log('tray', 'warn', 'tray icon image failed to load — skipping tray item');
      return;
    }
    const tray = new Tray(icon);
    tray.setToolTip('Pokéharness');
    // No `setContextMenu()` — that would build the menu once and let
    // Electron cache it, showing stale figures on every open after the
    // first. Building it fresh in `openMenu()` and popping it up explicitly
    // is what makes "fresh on every open" (this file's whole reason for
    // being simpler than the popover it replaced) actually true. No
    // `mouse-down`/tray-activation-likely listener here (there was one in
    // this file's first pass) — a status-item menu opens WITHOUT activating
    // the app the way the old popover BrowserWindow's `show()`/`focus()`
    // did, so there's nothing left for that listener to guard against; see
    // git history / index.ts's `leave-full-screen` listener comment for
    // what it used to catch.
    tray.on('click', () => this.openMenu());
    tray.on('right-click', () => this.openMenu());
    this.tray = tray;
    nativeTheme.on('updated', this.onThemeUpdated);
    this.freshnessTimer = setInterval(() => this.checkFreshness(), FRESHNESS_POLL_MS);
    this.scheduleRender();
  }

  /** App-teardown cleanup — mirrors every other main-process watcher's own
   *  `stop()`/`shutdown()` (see before-quit in index.ts). `rowRenderer`'s
   *  hidden `BrowserWindow` is destroyed here too (see `TrayRowRenderer
   *  .destroy()`'s own comment for why that can never hang `app.quit()`) —
   *  this is the ONLY place that hidden window is ever torn down, so a
   *  caller that forgets to call `destroy()` would leak it, same as `tray`
   *  itself. */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    nativeTheme.removeListener('updated', this.onThemeUpdated);
    if (this.pendingRenderTimer) {
      clearTimeout(this.pendingRenderTimer);
      this.pendingRenderTimer = null;
    }
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    this.rowRenderer.destroy();
  }

  /** Pops the menu up IMMEDIATELY from whatever's already cached (both the
   *  data — `UsageService`/`CostHistoryService`'s own synchronous reads —
   *  and the row IMAGES — `renderedImages`, from a prior background
   *  render), then kicks off a real data refresh in the background for the
   *  next open — see this file's own header ("Latency"/"Render scheduling")
   *  for the full reasoning. Fully synchronous up to `popUpContextMenu` (no
   *  `await` anywhere before it), which is deliberate, not just an
   *  optimization: it means there's no window in which `destroy()` could
   *  null out `this.tray` out from under this call, and no window in which
   *  a second rapid click could race this one — both would need an `await`
   *  to land in between to happen at all. */
  private openMenu(): void {
    if (!this.tray) return;
    const palette = nativeTheme.shouldUseDarkColors ? DARK_PALETTE : LIGHT_PALETTE;
    let template: MenuItemConstructorOptions[];
    try {
      template = this.buildTemplate(palette);
    } catch (e) {
      // Every read this pulls from is documented not to throw (see each
      // call site below), so this is belt-and-suspenders — but a menu build
      // that threw here would otherwise surface as an uncaught exception
      // inside Electron's 'click' emitter, for a click that should have
      // just silently done nothing.
      log('tray', 'warn', 'failed to build tray menu', { message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.tray.popUpContextMenu(Menu.buildFromTemplate(template));
    void this.refreshCaches();
  }

  /** Every row's data, read synchronously and fresh (no network/scan
   *  waiting): `UsageService.getSnapshot()` and `CostHistoryService.peek()`
   *  both just return their current in-memory cache, never triggering a
   *  poll/scan themselves — that's `refreshCaches()`'s job, run AFTER this
   *  menu is already on screen. Each row uses its cached image only if that
   *  image was rendered from the EXACT same spec this fresh data just
   *  produced (see this file's own header); otherwise it falls back to a
   *  plain native-text row for just that one row. */
  private buildTemplate(palette: TrayPalette): MenuItemConstructorOptions[] {
    const usage = this.deps.usageService.getSnapshot();
    const cost = this.deps.costHistory.peek();
    const hasAttempted = this.deps.costHistory.hasAttempted();
    const sessions = countSessions(this.deps.getSessionRegistry());
    const entries = buildTrayEntries(usage, cost, hasAttempted, sessions, palette);
    const items: MenuItemConstructorOptions[] = [];
    let rowIndex = 0;
    for (const entry of entries) {
      if (entry.type === 'separator') {
        items.push({ type: 'separator' });
        continue;
      }
      const idx = rowIndex++;
      const specJson = JSON.stringify(entry.spec);
      const image = this.renderedSpecsJson[idx] === specJson ? this.renderedImages[idx] : undefined;
      items.push(image ? infoRow('', image, entry.tooltip) : infoRow(entry.fallbackText, undefined, entry.tooltip));
    }
    items.push(
      { type: 'separator' },
      { label: 'Open Pokéharness', click: () => this.deps.onOpenWindow() },
      // `role: 'quit'` calls `app.quit()` under the hood — the SAME entry
      // point Cmd+Q / Dock quit / the app-menu Quit item already use, so
      // this goes through the existing `before-quit` live-session
      // confirmation gate for free rather than needing its own quit path.
      // Electron's `'quit'` role supplies its own default "Cmd+Q"
      // accelerator label on macOS — no explicit `accelerator` needed.
      { label: 'Quit', role: 'quit' }
    );
    return items;
  }

  /** The real (possibly network-bound / child-process-spawning) refresh —
   *  `UsageService.refreshNow()` and `CostHistoryService.getSnapshot()`,
   *  the same two calls `openMenu()` used to await before showing anything.
   *  Fire-and-forget from `openMenu()`: this updates each service's own
   *  cache for whenever the menu is next opened, and is never on the
   *  critical path for THIS open. Both calls already swallow their own
   *  errors into a fallback snapshot (see each service's own header), so
   *  this try/catch is belt-and-suspenders against an unexpected rejection
   *  turning into an unhandled one from a `void`-called async method.
   *  Schedules a row-image render afterward either way — this is the
   *  primary trigger for "usage or cost data changed" (see this file's own
   *  header, "Render scheduling"). */
  private async refreshCaches(): Promise<void> {
    try {
      await Promise.all([this.deps.usageService.refreshNow(), this.deps.costHistory.getSnapshot()]);
    } catch (e) {
      log('tray', 'warn', 'failed to refresh tray menu data', { message: e instanceof Error ? e.message : String(e) });
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.pendingRenderTimer) clearTimeout(this.pendingRenderTimer);
    this.pendingRenderTimer = setTimeout(() => {
      this.pendingRenderTimer = null;
      void this.renderNow();
    }, RENDER_DEBOUNCE_MS);
  }

  /** Cheap poll — see this file's own header ("Render scheduling") for why
   *  session counts need one at all. Only ever calls `scheduleRender()`
   *  (never renders directly), so this still goes through the same debounce
   *  as every other trigger. */
  private checkFreshness(): void {
    if (!this.tray) return;
    const usage = this.deps.usageService.getSnapshot();
    const cost = this.deps.costHistory.peek();
    const sessions = countSessions(this.deps.getSessionRegistry());
    const fingerprint = JSON.stringify([
      usage.updatedAt,
      cost.generatedAt,
      sessions.working,
      sessions.idle,
      sessions.needsYou,
      nativeTheme.shouldUseDarkColors
    ]);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.scheduleRender();
  }

  /** The only place that actually calls `TrayRowRenderer.render()` — always
   *  off the synchronous `openMenu()` path (see this file's own header).
   *  Recomputes the same `buildTrayEntries()` `buildTemplate()` will use at
   *  the next open, so `renderedSpecsJson[i]` is directly comparable against
   *  whatever spec that next open freshly computes for row `i`. */
  private async renderNow(): Promise<void> {
    if (!this.tray) return;
    const palette = nativeTheme.shouldUseDarkColors ? DARK_PALETTE : LIGHT_PALETTE;
    const usage = this.deps.usageService.getSnapshot();
    const cost = this.deps.costHistory.peek();
    const hasAttempted = this.deps.costHistory.hasAttempted();
    const sessions = countSessions(this.deps.getSessionRegistry());
    const entries = buildTrayEntries(usage, cost, hasAttempted, sessions, palette);
    const rowSpecs = entries.filter((e): e is Extract<TrayEntry, { type: 'row' }> => e.type === 'row').map((e) => e.spec);
    const generation = ++this.renderGeneration;
    try {
      const images = await this.rowRenderer.render(rowSpecs, palette);
      if (generation !== this.renderGeneration || !this.tray) return; // superseded, or torn down mid-render
      this.renderedImages = images;
      this.renderedSpecsJson = rowSpecs.map((s) => JSON.stringify(s));
    } catch (e) {
      // Leaves whatever was cached before (possibly nothing, at startup)
      // in place — `buildTemplate()`'s per-row spec match already handles a
      // stale/missing cache by falling back to plain text.
      log('tray', 'warn', 'failed to render tray row images', { message: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** `~/build/icon/tray/pokeballTemplate{,@2x}.png` — a monochrome template
 *  image (see build/icon/gen-tray-icon.mjs's own header for why it's flat
 *  and dithering-free rather than shaded, and this feature's own design
 *  decision for why it's monochrome at all: `setTemplateImage(true)` below
 *  hands dark/light menu-bar adaptation to macOS itself). Packaged builds
 *  ship these via `package.json`'s `build.mac.extraResources` (`tray/` →
 *  `Resources/tray/`, i.e. `process.resourcesPath/tray`); dev has no such
 *  extraResources copy, so this falls back to the repo source path off
 *  `process.cwd()` — same pattern `NON_MAC_WINDOW_ICON` in index.ts already
 *  uses for a source-relative icon path. Electron resolves
 *  the `@2x` sibling automatically from the `@1x` path handed to
 *  `nativeImage.createFromPath` as long as both live in the same
 *  directory — no separate `setTemplateImage`-per-size wiring needed. */
function loadTemplateIcon(): NativeImage {
  const dir = process.resourcesPath && existsSync(join(process.resourcesPath, 'tray'))
    ? join(process.resourcesPath, 'tray')
    : join(process.cwd(), 'build/icon/tray');
  const image = nativeImage.createFromPath(join(dir, 'pokeballTemplate.png'));
  image.setTemplateImage(true);
  return image;
}
