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
 * The cost of that switch: an `NSMenuItem` can't run arbitrary HTML/CSS, so
 * the popover's progress-bar gauges and cost sparkline (both CSS) become
 * `nativeImage`s hand-drawn into each item's icon slot instead — see
 * `buildMeterImage`/`buildSparklineImage` below. Both are redrawn from
 * scratch on every menu open (see `openMenu`), reading `nativeTheme`
 * directly (NOT the app's own theme setting — a status-item menu is OS
 * chrome with an OS-owned background, unlike the popover which painted its
 * own; picking the palette from the app's setting instead of the actual
 * menu-bar appearance would paint a light palette onto a dark menu, or vice
 * versa, whenever they disagree), so there's no cached image to invalidate
 * when the OS theme flips and no `syncTheme`/reload-on-theme-change
 * machinery to carry over from the old popover (a persisted `BrowserWindow`
 * had to be told to reload; a menu that doesn't exist until the moment it's
 * clicked doesn't).
 *
 * Latency: `openMenu()` pops up from whatever's already cached in
 * `UsageService`/`CostHistoryService` (both synchronous reads —
 * `getSnapshot()`/`peek()`) and only AFTER popping fires off a real refresh
 * for next time. The first version of this file awaited that refresh
 * BEFORE showing the menu, which is fine for a popover (it has a window to
 * show a "loading…" state in while it waits) but wrong for a menu, which
 * has no such state — a click ≥60s after the last one would silently hang
 * for however long `UsageService.refreshNow()`'s network calls take, then
 * pop a menu the user may have already moved on from.
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

// ─── HP-bar / sparkline pixel rendering ─────────────────────────────────────
// Every color role a meter/sparkline image needs, hand-matched to
// design/tokens.ts's dark constants and their `*Light` counterparts (same
// values the deleted trayPopoverHtml.ts copied in for the same reason: this
// file has no build step that can resolve a TS import into a raw pixel
// buffer, so the hexes are literal here too). Meters are colour-coded by
// fill level, so — unlike the tray icon itself — they can never be a
// monochrome `setTemplateImage(true)` image; theme adaptation instead means
// picking the right palette and redrawing before every open (see
// `TrayController.openMenu`).
interface TrayPalette {
  /** Segment/track outline — ground[300]/groundLight[300]. */
  border: string;
  /** Empty-segment fill — ground.terminal/groundLight.terminal. */
  barTrack: string;
  /** Low-usage (comfortable) segment fill — status.done/statusLight.done. */
  done: string;
  /** Mid-usage segment fill — status.working/statusLight.working. */
  warn: string;
  /** High-usage segment fill — status.blocked/statusLight.blocked. */
  danger: string;
  /** Sparkline bar fill — gold/goldLight. */
  accent: string;
  /** Zero-cost sparkline bar fill — ground.disabled/groundLight.disabled. */
  disabled: string;
}

const DARK_PALETTE: TrayPalette = {
  border: '#787684',
  barTrack: '#1A1A1F',
  done: '#6FB88B',
  warn: '#D8B052',
  danger: '#DF8078',
  accent: '#E8B740',
  disabled: '#313139'
};

const LIGHT_PALETTE: TrayPalette = {
  border: '#A899B5',
  barTrack: '#FCFAF0',
  done: '#5CA97A',
  warn: '#DCAB3C',
  danger: '#D96A62',
  accent: '#DCAB3C',
  disabled: '#E8D9A0'
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** `nativeImage.createFromBuffer`'s raw format is BGRA (Skia's native
 *  little-endian bitmap layout, same as Chromium uses internally) — NOT the
 *  RGBA order the color roles above are written in, hence `paintPixel`
 *  swapping r/b on write rather than the palette itself. */
function makeBitmap(widthPx: number, heightPx: number): Buffer {
  return Buffer.alloc(widthPx * heightPx * 4);
}

function paintPixel(buf: Buffer, widthPx: number, x: number, y: number, c: Rgb): void {
  const i = (y * widthPx + x) * 4;
  buf[i] = c.b;
  buf[i + 1] = c.g;
  buf[i + 2] = c.r;
  buf[i + 3] = 255;
}

/** Every pixel in the rect is painted at full opacity with no blending —
 *  the source of this file's "hard pixel edges, no antialiasing" look
 *  (there's nothing here that could ever produce a partial-alpha edge
 *  pixel, unlike a vector/canvas rect fill would at a non-integer boundary). */
function paintRect(buf: Buffer, widthPx: number, heightPx: number, x0: number, y0: number, w: number, h: number, c: Rgb): void {
  const xEnd = Math.min(widthPx, x0 + w);
  const yEnd = Math.min(heightPx, y0 + h);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) paintPixel(buf, widthPx, x, y, c);
  }
}

/** Drawn at 2x and handed to `createFromBuffer` with `scaleFactor: 2` for
 *  every meter/sparkline image below — plain 1x pixel art would look soft
 *  on a Retina menu bar (macOS scales a 1x `NativeImage` up rather than
 *  trusting it's already crisp), and the whole point of the segmented,
 *  hard-edged HP-bar look is that it reads as pixel art, not a blur. */
const IMAGE_SCALE = 2;

function gaugeTone(percent: number): 'normal' | 'warn' | 'danger' {
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warn';
  return 'normal';
}

// 10, not 14 — at the narrower 72pt image width (see METER_WIDTH_PT), 14
// segments leaves each fill only 2pt wide after its 1pt border, too thin to
// read; 10 segments gives each one a comfortable 4pt fill.
const METER_SEGMENTS = 10;
const METER_WIDTH_PT = 72;
const METER_HEIGHT_PT = 9;

/** One HP-style gauge — the app's Game Boy visual identity applied to a
 *  usage percentage: `METER_SEGMENTS` discrete pixel blocks (not a
 *  continuous fill bar), each segment either fully lit (fill color) or
 *  fully unlit (track color) — a segment is never partially lit, matching
 *  a real Game Boy HP bar's all-or-nothing block granularity rather than a
 *  smooth progress meter. */
function buildMeterImage(percent: number, palette: TrayPalette): NativeImage {
  const w = METER_WIDTH_PT * IMAGE_SCALE;
  const h = METER_HEIGHT_PT * IMAGE_SCALE;
  const buf = makeBitmap(w, h);
  const tone = gaugeTone(percent);
  const fillRgb = hexToRgb(tone === 'danger' ? palette.danger : tone === 'warn' ? palette.warn : palette.done);
  const trackRgb = hexToRgb(palette.barTrack);
  const borderRgb = hexToRgb(palette.border);
  const clamped = Math.max(0, Math.min(100, percent));
  const filledSegments = Math.round((clamped / 100) * METER_SEGMENTS);
  const gap = IMAGE_SCALE;
  const segW = Math.floor((w - gap * (METER_SEGMENTS - 1)) / METER_SEGMENTS);
  let x = 0;
  for (let i = 0; i < METER_SEGMENTS; i++) {
    paintRect(buf, w, h, x, 0, segW, h, borderRgb);
    paintRect(buf, w, h, x + IMAGE_SCALE, IMAGE_SCALE, segW - 2 * IMAGE_SCALE, h - 2 * IMAGE_SCALE, i < filledSegments ? fillRgb : trackRgb);
    x += segW + gap;
  }
  return nativeImage.createFromBuffer(buf, { width: w, height: h, scaleFactor: IMAGE_SCALE });
}

const SPARK_WIDTH_PT = 72;
const SPARK_HEIGHT_PT = 24;

/** 30-day cost sparkline — one hard-edged bar per `days[]` entry, height
 *  proportional to that day's cost against the window's own max (a zero-cost
 *  day still draws a minimum-height `disabled`-colored bar rather than
 *  nothing, so the axis stays readable). */
function buildSparklineImage(days: CostHistoryDay[], palette: TrayPalette): NativeImage {
  const w = SPARK_WIDTH_PT * IMAGE_SCALE;
  const h = SPARK_HEIGHT_PT * IMAGE_SCALE;
  const buf = makeBitmap(w, h);
  const accentRgb = hexToRgb(palette.accent);
  const zeroRgb = hexToRgb(palette.disabled);
  const max = days.reduce((m, d) => Math.max(m, d.costUsd), 0);
  const n = Math.max(1, days.length);
  const gap = IMAGE_SCALE;
  const barW = Math.max(IMAGE_SCALE, Math.floor((w - gap * (n - 1)) / n));
  let x = 0;
  for (const d of days) {
    const isZero = d.costUsd <= 0;
    const barH = isZero ? IMAGE_SCALE : Math.max(2 * IMAGE_SCALE, Math.round((d.costUsd / max) * h));
    paintRect(buf, w, h, x, h - barH, barW, barH, isZero ? zeroRgb : accentRgb);
    x += barW + gap;
  }
  return nativeImage.createFromBuffer(buf, { width: w, height: h, scaleFactor: IMAGE_SCALE });
}

// ─── Text formatting (unchanged behavior from the deleted popover's own
// inline script — same rounding/thresholds, just TypeScript instead of a
// string-embedded <script>) ──────────────────────────────────────────────

/** `UsageWindow.label`'s short chip form ('5h' | '7d' | 'credits' | ...) to
 *  the friendlier phrase this menu's rows use — anything else (a
 *  model-scoped promotional window's bare scope name) is shown as-is. */
function friendlyWindowLabel(label: string): string {
  if (label === '5h') return 'session (5h)';
  if (label === '7d') return 'weekly (7d)';
  if (label === 'credits') return 'extra credits';
  return label;
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
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

function fmtTokens(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI' };

/** One `UsageWindow` → one disabled, icon-carrying menu row. `balanceOnly`
 *  rows (Codex's credit balance — no known max) skip the meter entirely,
 *  same as the deleted popover: there's no percentage to draw a gauge
 *  against. */
function buildWindowItem(w: UsageWindow, now: number, palette: TrayPalette): MenuItemConstructorOptions {
  const label = friendlyWindowLabel(w.label);
  if (w.balanceOnly) {
    return { label: w.balanceText ? `${label} — ${w.balanceText}` : label, click: () => {} };
  }
  const bits: string[] = [];
  const percent = w.spend ? (w.spend.limitCents > 0 ? (w.spend.usedCents / w.spend.limitCents) * 100 : 0) : w.usedPercent;
  bits.push(w.spend ? `${fmtUsd(w.spend.usedCents / 100)} / ${fmtUsd(w.spend.limitCents / 100)} ${w.spend.currency}` : `${Math.round(w.usedPercent)}%`);
  const resetText = fmtResetIn(w.resetsAt, now);
  if (resetText) bits.push(resetText);
  return { label: `${label} — ${bits.join(' · ')}`, click: () => {}, icon: buildMeterImage(percent, palette) };
}

/** The "Limits" section's rows — one block per provider that has anything to
 *  report (a provider sub-header only when more than one provider is
 *  present, so the common single-provider case stays as flat as the spec's
 *  three bullet rows). */
function buildUsageItems(usage: UsageSnapshot, palette: TrayPalette): MenuItemConstructorOptions[] {
  if (!usage.enabled) return [{ label: 'usage limits are off — enable them in settings', click: () => {} }];
  if (usage.providers.length === 0) return [{ label: 'no usage data yet', click: () => {} }];
  const now = Date.now();
  const multiProvider = usage.providers.length > 1;
  const items: MenuItemConstructorOptions[] = [];
  for (const p of usage.providers) {
    if (multiProvider) items.push({ label: PROVIDER_LABEL[p.provider] ?? p.provider, enabled: false });
    if (p.state === 'ok' || p.state === 'stale') {
      if (p.state === 'stale') {
        // `message`/`fmtAgo` can each independently be empty — join only the
        // non-empty ones so a missing one never leaves a dangling leading or
        // trailing " · ".
        const bits = [p.message, fmtAgo(p.updatedAt, now)].filter((bit): bit is string => Boolean(bit));
        if (bits.length > 0) items.push({ label: bits.join(' · '), click: () => {} });
      }
      if (p.windows.length === 0) items.push({ label: 'no usage windows reported', click: () => {} });
      for (const w of p.windows) items.push(buildWindowItem(w, now, palette));
    } else {
      items.push({ label: p.message ?? 'usage unavailable', click: () => {} });
    }
  }
  return items;
}

/** The "Cost" section's rows — sparkline first, then the four stats the
 *  spec kept (today, 30d total, latest turn, top model); `last30dTokens`
 *  the deleted popover also showed is dropped here, per that same spec.
 *  `hasAttempted` (`CostHistoryService.hasAttempted()`) disambiguates the
 *  empty-`days` case: `peek()` returns the same zeroed snapshot whether the
 *  first scan just hasn't finished yet OR every attempt so far has failed
 *  (`CostHistoryService`'s own `emptySnapshot()` fallback covers both), and
 *  those read very differently to a user — "computing…" implies it'll
 *  resolve on its own, which isn't true for the second case. */
function buildCostItems(cost: CostHistorySnapshot, hasAttempted: boolean, palette: TrayPalette): MenuItemConstructorOptions[] {
  if (cost.days.length === 0) {
    return [{ label: hasAttempted ? 'cost history unavailable' : 'computing…', click: () => {} }];
  }
  const items: MenuItemConstructorOptions[] = [
    { label: '30-day trend', click: () => {}, icon: buildSparklineImage(cost.days, palette) },
    { label: `today — ${fmtUsd(cost.todayCostUsd)}`, click: () => {} },
    { label: `last 30 days — ${fmtUsd(cost.last30dCostUsd)}`, click: () => {} },
    { label: `last turn — ${fmtTokens(cost.latestTurnTokens)} tok`, click: () => {} }
  ];
  if (cost.topModel) items.push({ label: `top model — ${cost.topModel.model} (${fmtTokens(cost.topModel.tokens)})`, click: () => {} });
  return items;
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

export class TrayController {
  private tray: Tray | null = null;

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
  }

  /** App-teardown cleanup — mirrors every other main-process watcher's own
   *  `stop()`/`shutdown()` (see before-quit in index.ts). Not strictly
   *  required (the OS reclaims everything on process exit either way), but
   *  keeps this controller symmetric with the rest of the app's lifecycle
   *  hygiene rather than being the one exception. */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /** Pops the menu up IMMEDIATELY from whatever's already cached, then kicks
   *  off a real refresh in the background for the next open — see this
   *  file's own header ("Latency") for why an await before showing was a
   *  regression. Fully synchronous up to `popUpContextMenu` (no `await`
   *  anywhere before it), which is deliberate, not just an optimization: it
   *  means there's no window in which `destroy()` could null out `this.tray`
   *  out from under this call, and no window in which a second rapid click
   *  could race this one — both would need an `await` to land in between to
   *  happen at all. */
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
   *  menu is already on screen. */
  private buildTemplate(palette: TrayPalette): MenuItemConstructorOptions[] {
    const usage = this.deps.usageService.getSnapshot();
    const costHistory = this.deps.costHistory.peek();
    const costHistoryAttempted = this.deps.costHistory.hasAttempted();
    const sessions = countSessions(this.deps.getSessionRegistry());
    return [
      { label: `${sessions.working} working · ${sessions.idle} idle · ${sessions.needsYou} needs you`, click: () => {} },
      { type: 'separator' },
      { label: 'Limits', enabled: false },
      ...buildUsageItems(usage, palette),
      { type: 'separator' },
      { label: 'Cost', enabled: false },
      ...buildCostItems(costHistory, costHistoryAttempted, palette),
      { type: 'separator' },
      { label: 'Open Pokéharness', click: () => this.deps.onOpenWindow() },
      // `role: 'quit'` calls `app.quit()` under the hood — the SAME entry
      // point Cmd+Q / Dock quit / the app-menu Quit item already use, so
      // this goes through the existing `before-quit` live-session
      // confirmation gate for free rather than needing its own quit path.
      { label: 'Quit', role: 'quit' }
    ];
  }

  /** The real (possibly network-bound / child-process-spawning) refresh —
   *  `UsageService.refreshNow()` and `CostHistoryService.getSnapshot()`,
   *  the same two calls `openMenu()` used to await before showing anything.
   *  Fire-and-forget from `openMenu()`: this updates each service's own
   *  cache for whenever the menu is next opened, and is never on the
   *  critical path for THIS open. Both calls already swallow their own
   *  errors into a fallback snapshot (see each service's own header), so
   *  this try/catch is belt-and-suspenders against an unexpected rejection
   *  turning into an unhandled one from a `void`-called async method. */
  private async refreshCaches(): Promise<void> {
    try {
      await Promise.all([this.deps.usageService.refreshNow(), this.deps.costHistory.getSnapshot()]);
    } catch (e) {
      log('tray', 'warn', 'failed to refresh tray menu data', { message: e instanceof Error ? e.message : String(e) });
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
