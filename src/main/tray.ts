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
 * split allows for most rows — a caption/value pair stacked over a
 * full-width bar, a right-aligned dim-ink value next to a semibold
 * caption — neither of which an `NSMenuItem`'s own icon+title layout can
 * produce. "Option A" (the locked-in design decision) draws each such row,
 * text included, as one image set as the item's `icon`, with an empty
 * label. `trayRowImages.ts` owns the actual rasterization (a hidden,
 * never-shown `BrowserWindow` running a `<canvas>` 2D context — see that
 * file's own header for why a window is required at all); this file owns
 * the data → `TrayRowSpec` decisions (what each row says, which colors/tones
 * apply) and the scheduling/caching around when to (re-)render and what to
 * show before the first render has ever completed. The session-status row
 * is the one row this pass deliberately keeps OUT of that system — see
 * `buildStatusMenuItem` below and "Render scheduling" further down for why.
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
 * (`renderedSpecsJson`) AND requires the theme it was drawn under
 * (`renderedDark`) to still match `nativeTheme.shouldUseDarkColors` — colors
 * travel separately from the spec (`render()`'s own `payload.colors`), so a
 * spec match alone can't tell a light-drawn image from a dark-drawn one —
 * and only trusts the image when both match (and it isn't `.isEmpty()`).
 * Every piece of TEXT that ends up inside a `TrayRowSpec` is deliberately
 * kept STABLE across renders a few seconds/minutes apart — this used to be
 * a real bug: `fmtResetIn` (now `fmtResetAt`) baked a relative "resets in
 * 2h 13m" string into a `window` row's spec, which changes every real
 * minute, so almost every open beyond about a minute after the render that
 * produced a cached image no longer matched it and fell back to plain text
 * — the drawn rows almost never actually showed. `fmtResetAt` now formats an
 * ABSOLUTE clock time instead (see its own comment), which only changes
 * when the calendar minute/day/month it names actually changes.
 *
 * Render scheduling: `scheduleRender()` (debounced `RENDER_DEBOUNCE_MS`,
 * coalescing bursts into one actual render) fires from exactly three
 * push-based places, no poll — `init()` subscribing to
 * `UsageService.onSnapshot` (fires once real usage data lands after boot,
 * not on a fixed timer during window creation while everything's still
 * placeholder — see `init()`'s own comment), `refreshCaches()` (after the
 * real usage/cost refresh `openMenu()` already kicks off post-popup
 * finishes — see `UsageService`/`CostHistoryService`'s own headers for why
 * THAT is already the right place to catch usage/cost changes), and
 * `nativeTheme`'s `'updated'` event (light/dark switch). `renderNow()`
 * itself no-ops if the freshly-computed specs and theme are already exactly
 * what's cached (see its own comment) — `refreshCaches()` fires after every
 * single open, but `UsageService.refreshNow()` is throttled to once/min and
 * returns the SAME data near-instantly otherwise, so without that check
 * most opens would still pay for a render that changes nothing. An earlier
 * version of this file also polled session status counts every few seconds
 * so the drawn status row wouldn't go stale between opens — removed
 * (battery cost with no bound on how long the app might sit idle in the
 * background) in favor of not drawing that row as an image at all: see
 * `buildStatusMenuItem` below, a REAL native-text `MenuItem` computed fresh
 * inside `buildTemplate()` on every open, same as "Open Pokéharness"/"Quit".
 * Native text has no rendering latency to hide, so it never needed the
 * image-cache/render-scheduling machinery the rest of this file exists for.
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

/** "3:45 PM" (or "3 PM" on the hour — minutes are dropped only when they're
 *  exactly zero). Locale is left `undefined` throughout this file's
 *  `Intl.DateTimeFormat` calls, which resolves to the user's own OS locale
 *  INCLUDING its 12h/24h convention with zero extra code — a 24h locale
 *  (no AM/PM marker) gets the same on-the-hour minute-dropping treatment. */
function formatClockTime(d: Date): string {
  if (d.getMinutes() === 0) return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(d);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `w.resetsAt` → an absolute wall-clock string, NEVER relative ("in 2h
 *  13m") text — a relative string re-renders its own value every minute,
 *  which used to make it part of a `TrayRowSpec` that could never stay
 *  byte-identical between the render that produced a cached image and the
 *  NEXT open's freshly-computed spec (`buildTemplate`'s per-row match below
 *  is exact-string equality): in practice almost every open beyond about a
 *  minute after the last render fell back to plain text instead of showing
 *  the drawn row at all. An absolute time only changes when the actual
 *  calendar minute/day/month it names changes, which happens far less often
 *  than "the last render is a minute old". Three formats, closest granularity
 *  first: today's clock time ("resets 3:45 PM"), a weekday + clock time
 *  within the next week ("resets Tue 3 PM"), or a bare date further out
 *  ("resets Sep 30"). */
function fmtResetAt(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  if (resetsAt <= now) return 'resets soon';
  const reset = new Date(resetsAt);
  const today = new Date(now);
  const sameDay = reset.getFullYear() === today.getFullYear() && reset.getMonth() === today.getMonth() && reset.getDate() === today.getDate();
  if (sameDay) return `resets ${formatClockTime(reset)}`;
  const diffDays = Math.round((startOfLocalDay(reset) - startOfLocalDay(today)) / 86400000);
  if (diffDays >= 1 && diffDays <= 7) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(reset);
    return `resets ${weekday} ${formatClockTime(reset)}`;
  }
  return `resets ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(reset)}`;
}

/** Still minute-ticking text, unlike `fmtResetAt` above — left as-is because
 *  its only call site (`buildLimitsEntries`'s 'stale'-state branch) already
 *  puts it in its OWN separate `textEntry` row, never combined into a
 *  `window` row's cache key. `buildTemplate`'s per-row (not per-menu) spec
 *  match means that isolation is enough on its own: this ONE "as of Xm ago"
 *  row may fall back to plain native text most opens, same as it always
 *  could, but it can never drag a `window` row's percent/bar down with it. */
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
  const resetText = fmtResetAt(w.resetsAt, now);
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

function buildTrayEntries(usage: UsageSnapshot, cost: CostHistorySnapshot, hasAttempted: boolean, palette: TrayPalette): TrayEntry[] {
  return [...buildLimitsEntries(usage, palette), { type: 'separator' }, ...buildCostEntries(cost, hasAttempted, palette)];
}

/** The session-status row — kept as a REAL native-text `MenuItem`, not a
 *  drawn image (see this file's own header, "Render scheduling"): it's the
 *  one row whose underlying data (`sessionRegistry`, mirrored via
 *  `getSessionRegistry`) can change on its own, with no "I just refreshed"
 *  moment to hook a render off of, so keeping it native means it's always
 *  exactly as fresh as this open, for free, the same way "Open
 *  Pokéharness"/"Quit" already are. The tradeoff is layout: a plain
 *  `NSMenuItem` title is one run of text in one color, so this can't
 *  reproduce the mockup's colored status dot or its right-aligned "N need
 *  you" — both of those need either an image (which is exactly the
 *  render-latency/staleness problem being avoided here) or a rich
 *  `NSMenuItem.view` Electron doesn't expose. Left as a single left-aligned
 *  line instead. */
function buildStatusMenuItem(sessions: TraySessionCounts): MenuItemConstructorOptions {
  return infoRow(`${sessions.working} working · ${sessions.idle} idle · ${sessions.needsYou} need you`);
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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class TrayController {
  private tray: Tray | null = null;
  private readonly rowRenderer = new TrayRowRenderer();
  /** Parallel to `renderedSpecsJson` below — `renderedImages[i]` is only
   *  trusted for row `i` of a fresh `buildTemplate()` pass when
   *  `renderedSpecsJson[i]` still matches that row's freshly-computed spec
   *  (see this file's own header, "SYNCHRONOUS OPEN, ASYNCHRONOUS RENDER"). */
  private renderedImages: NativeImage[] = [];
  private renderedSpecsJson: string[] = [];
  /** The `nativeTheme.shouldUseDarkColors` value the CURRENT `renderedImages`
   *  were drawn under — the colors live in `render()`'s `payload.colors`,
   *  never inside a `TrayRowSpec` itself, so two specs can be byte-identical
   *  across a light/dark switch even though they'd need to be redrawn in the
   *  other palette's ink. `buildTemplate()` requires this to still equal
   *  `nativeTheme.shouldUseDarkColors` (alongside the usual per-row spec
   *  match) before trusting a cached image — `null` (nothing successfully
   *  rendered yet) can never equal either boolean, so this also naturally
   *  covers "no render has completed" without a separate check. */
  private renderedDark: boolean | null = null;
  private pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slower, superseded `renderNow()` call overwriting a
   *  faster, later one's result if two ever overlap (shouldn't happen given
   *  the debounce above always clears any still-pending timer first, but
   *  cheap insurance against a future scheduling change reintroducing the
   *  race). */
  private renderGeneration = 0;
  private readonly onThemeUpdated = () => this.scheduleRender();
  /** Unsubscribes from `UsageService.onSnapshot` — set in `init()`, called
   *  in `destroy()`, same lifecycle as the `nativeTheme` listener above. */
  private unsubscribeUsageSnapshot: (() => void) | null = null;

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
    // No unconditional `scheduleRender()` here — right after `whenReady`,
    // usage/cost data is still whatever placeholder each service starts
    // with (`UsageService`'s snapshot defaults to `{ enabled: false,
    // providers: [] }` until its own boot poll resolves), so rendering
    // immediately would burn a render on a menu nobody's looking at yet AND
    // leave a stale-looking cache sitting there once real data lands a
    // moment later. `UsageService.onSnapshot` (new — see that file) fires
    // every time its cache actually changes, including the very first real
    // poll after boot, which is the actual "there's something worth
    // rendering now" signal; `nativeTheme`'s listener above and
    // `refreshCaches()` below cover the other two cases. If usage limits
    // are off and nothing else happens to trigger a render first, the very
    // first menu open still falls back to plain native text for every row
    // — the same already-documented, already-accepted fallback this file's
    // header describes for "before the first render has ever completed".
    this.unsubscribeUsageSnapshot = this.deps.usageService.onSnapshot(() => this.scheduleRender());
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
    this.unsubscribeUsageSnapshot?.();
    this.unsubscribeUsageSnapshot = null;
    if (this.pendingRenderTimer) {
      clearTimeout(this.pendingRenderTimer);
      this.pendingRenderTimer = null;
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
   *  produced, UNDER THE SAME THEME (`renderedDark`, see its own comment —
   *  the colors aren't part of the spec, so a spec match alone isn't
   *  enough), and that image isn't empty (`NativeImage.isEmpty()` — a
   *  defensive check against a decode that technically "succeeded" into
   *  nothing usable); otherwise it falls back to a plain native-text row
   *  for just that one row. */
  private buildTemplate(palette: TrayPalette): MenuItemConstructorOptions[] {
    const usage = this.deps.usageService.getSnapshot();
    const cost = this.deps.costHistory.peek();
    const hasAttempted = this.deps.costHistory.hasAttempted();
    const sessions = countSessions(this.deps.getSessionRegistry());
    const entries = buildTrayEntries(usage, cost, hasAttempted, palette);
    const items: MenuItemConstructorOptions[] = [buildStatusMenuItem(sessions), { type: 'separator' }];
    const themeMatches = this.renderedDark === nativeTheme.shouldUseDarkColors;
    let rowIndex = 0;
    for (const entry of entries) {
      if (entry.type === 'separator') {
        items.push({ type: 'separator' });
        continue;
      }
      const idx = rowIndex++;
      const specJson = JSON.stringify(entry.spec);
      const cached = themeMatches && this.renderedSpecsJson[idx] === specJson ? this.renderedImages[idx] : undefined;
      const image = cached && !cached.isEmpty() ? cached : undefined;
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

  /** The only place that actually calls `TrayRowRenderer.render()` — always
   *  off the synchronous `openMenu()` path (see this file's own header).
   *  Recomputes the same `buildTrayEntries()` `buildTemplate()` will use at
   *  the next open, so `renderedSpecsJson[i]` is directly comparable against
   *  whatever spec that next open freshly computes for row `i`. Skips the
   *  actual render (and the round trip to the hidden window that costs) if
   *  the freshly-computed specs AND the theme are already exactly what's
   *  cached — `refreshCaches()` calls this after EVERY open, but
   *  `UsageService.refreshNow()` returns near-instantly, with unchanged
   *  data, whenever its own throttle is active (most opens within a minute
   *  of the last one), so without this check almost every open would pay
   *  for a full render that produces byte-identical images to what's
   *  already cached. */
  private async renderNow(): Promise<void> {
    if (!this.tray) return;
    const isDark = nativeTheme.shouldUseDarkColors;
    const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
    const usage = this.deps.usageService.getSnapshot();
    const cost = this.deps.costHistory.peek();
    const hasAttempted = this.deps.costHistory.hasAttempted();
    const entries = buildTrayEntries(usage, cost, hasAttempted, palette);
    const rowSpecs = entries.filter((e): e is Extract<TrayEntry, { type: 'row' }> => e.type === 'row').map((e) => e.spec);
    const newSpecsJson = rowSpecs.map((s) => JSON.stringify(s));
    if (isDark === this.renderedDark && arraysEqual(newSpecsJson, this.renderedSpecsJson)) return;
    const generation = ++this.renderGeneration;
    try {
      const images = await this.rowRenderer.render(rowSpecs, palette);
      if (generation !== this.renderGeneration || !this.tray) return; // superseded, or torn down mid-render
      this.renderedImages = images;
      this.renderedSpecsJson = newSpecsJson;
      this.renderedDark = isDark;
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
