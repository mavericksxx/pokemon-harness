/**
 * TrayController — macOS menu-bar (Tray) item, GitHub issue #17. Custom
 * popover panel (not a native `Menu`), per the issue's locked-in design
 * decision: progress bars and a cost sparkline can't be drawn inside a
 * native `NSMenu` item, so the popover is its own small frameless/
 * transparent `BrowserWindow`, positioned under the tray icon
 * (`tray.getBounds()`), shown on click and hidden on blur — the standard
 * Electron tray-popover recipe.
 *
 * This is NOT the main renderer's React app — a second, much lighter
 * `BrowserWindow` with its own tiny preload (trayPopoverPreload.ts) and a
 * whole-document HTML string (trayPopoverHtml.ts) loaded via a `data:` URL,
 * plain DOM/vanilla JS, no bundler step. That's a deliberate scope choice,
 * not an oversight: this panel only ever needs to render three read-only
 * sections off data this process already has in memory or cheaply caches
 * (usage snapshot, cost history, session counts) — pulling in React/the
 * renderer's build pipeline for that would be real weight for no benefit.
 * One visual tradeoff that choice costs: the main app's self-hosted Press
 * Start 2P pixel font isn't loaded here (shipping a font asset to a page
 * outside the renderer's own vite pipeline is packaging work this panel's
 * three-section, read-only scope didn't seem to justify) — every color,
 * border, radius, shadow and gauge-tone threshold below is still copied
 * from design/tokens.ts, just not the pixel typeface.
 *
 * Data sources, one per popover section:
 *  - usage limits   → UsageService.refreshNow() (usageService.ts) — same
 *                      throttled (>=60s) popover-open refresh UsageChip.tsx
 *                      already does, so opening the tray popover can't
 *                      hammer the usage endpoint any harder than the
 *                      in-app chip already doesn't.
 *  - cost history    → CostHistoryService.getSnapshot() (costHistory.ts) —
 *                      TTL-cached; see that file's own header.
 *  - agent statuses   → the `sessionRegistry` mirror (main/index.ts),
 *                      passed in as a getter (same forward-reference
 *                      pattern `pokeRelay`/`sessionTitleWatcher` already
 *                      use for the same field).
 */
import { BrowserWindow, ipcMain, nativeImage, screen, Tray, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageService } from './usageService';
import type { CostHistoryService } from './costHistory';
import type { SessionRecord } from '../shared/types';
import type { TrayPopoverData, TraySessionCounts } from '../shared/trayTypes';
import { buildTrayPopoverHtml } from './trayPopoverHtml';
import { log } from './diagnostics';

/** Fallback for the `tray:getData` handler's own catch — `collectData()`
 *  shouldn't actually be able to throw (both its underlying calls already
 *  swallow their own errors), but the handler must never let an `invoke()`
 *  reject: the popover's pull-based fetch (see `init()`'s own comment) has
 *  no retry path of its own for a rejected promise. */
const EMPTY_TRAY_DATA: TrayPopoverData = {
  usage: { enabled: false, providers: [], updatedAt: 0 },
  costHistory: { generatedAt: 0, days: [], todayCostUsd: 0, last30dCostUsd: 0, latestTurnTokens: null, last30dTokens: 0, topModel: null },
  sessions: { working: 0, idle: 0, needsYou: 0 }
};

/** The panel's own visual width — trayPopoverHtml.ts's `.frame` fills
 *  whatever width the transparent window gives it, minus its own left/right
 *  margin (reserved for the hard-offset CSS shadow — see that file's
 *  `.frame` rule). `WINDOW_WIDTH` below is what actually gets handed to
 *  `BrowserWindow`/`setBounds`; kept as one constant used in BOTH
 *  `createPopover` and `positionUnderTray` so the window is never resized
 *  between creation and first position (which would show as a visible
 *  jump). */
const POPOVER_WIDTH = 340;
const SHADOW_MARGIN_PX = 12;
const WINDOW_WIDTH = POPOVER_WIDTH + SHADOW_MARGIN_PX;
const POPOVER_HEIGHT = 560;

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

export interface TrayControllerDeps {
  usageService: UsageService;
  costHistory: CostHistoryService;
  getSessionRegistry: () => SessionRecord[];
  /** Same resolver `index.ts` already uses for `resolveWindowBg`/
   *  `ptyManager.setTerminalAppearance` — so the popover's light/dark call
   *  for `'system'` mode matches the rest of the app exactly rather than
   *  re-deriving its own. */
  getEffectiveTheme: () => 'light' | 'dark';
  /** Invoked as early as possible on any tray interaction (see `init()`'s
   *  `mouse-down` listener, which fires ahead of `click`) — lets the main
   *  window's fullscreen listener distinguish an OS-forced fullscreen exit
   *  (caused by the tray click activating the app) from a legitimate
   *  user-initiated one. */
  onLikelyActivate: () => void;
}

export class TrayController {
  private tray: Tray | null = null;
  private popover: BrowserWindow | null = null;
  /** The theme `popover`'s current document was last built with — `null`
   *  until the popover exists. Compared against `deps.getEffectiveTheme()`
   *  to decide whether an existing (possibly hidden/reused) popover needs a
   *  fresh `loadURL()` rather than always rebuilding on every open. */
  private popoverTheme: 'light' | 'dark' | null = null;
  /** Guards against the classic Electron tray-popover double-fire — see
   *  `toggle()`'s own comment. */
  private static readonly REOPEN_GUARD_MS = 250;
  private lastHideAt = 0;

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
    tray.on('click', () => this.toggle());
    // Fires earlier/closer to the actual native click than `click` above —
    // see `onLikelyActivate`'s doc comment for why that matters.
    tray.on('mouse-down', () => this.deps.onLikelyActivate());
    this.tray = tray;
    ipcMain.on('tray:close', () => this.hide());
    // Pull, not push: the popover page calls this itself (on load, and again
    // every time it becomes visible — see trayPopoverHtml.ts's own comment)
    // rather than main pushing a snapshot after `show()`. A push raced the
    // page's own listener registration on a cold first open — `show()` could
    // `send()` before the page had even started executing its inline
    // `<script>`, silently dropping the one-and-only message and leaving the
    // popover stuck on its static "loading…" markup forever. Pulling has no
    // such ordering dependency: whenever the page asks, the answer is ready.
    ipcMain.handle('tray:getData', async (): Promise<TrayPopoverData> => {
      try {
        return await this.collectData();
      } catch (e) {
        log('tray', 'warn', 'failed to collect popover data', { message: e instanceof Error ? e.message : String(e) });
        return EMPTY_TRAY_DATA;
      }
    });
  }

  /** App-teardown cleanup — mirrors every other main-process watcher's own
   *  `stop()`/`shutdown()` (see before-quit in index.ts). Not strictly
   *  required (the OS reclaims everything on process exit either way), but
   *  keeps this controller symmetric with the rest of the app's lifecycle
   *  hygiene rather than being the one exception. */
  destroy(): void {
    ipcMain.removeAllListeners('tray:close');
    ipcMain.removeHandler('tray:getData');
    if (this.popover && !this.popover.isDestroyed()) this.popover.destroy();
    this.popover = null;
    this.popoverTheme = null;
    this.tray?.destroy();
    this.tray = null;
  }

  /** Called from `index.ts` whenever the effective theme might have changed
   *  while the popover is already open — an explicit theme-setting switch,
   *  or (in `'system'` mode) a live OS-appearance flip, mirroring the
   *  `nativeTheme.on('updated', ...)` listener that already re-resolves
   *  `resolveTerminalAppearance` for the terminal elsewhere in `index.ts`.
   *  A no-op if the popover doesn't exist, isn't visible (its theme is
   *  reconciled on the next `show()` instead — see there), or the effective
   *  theme didn't actually change. */
  syncTheme(): void {
    if (!this.popover || this.popover.isDestroyed() || !this.popover.isVisible()) return;
    const theme = this.deps.getEffectiveTheme();
    if (theme === this.popoverTheme) return;
    this.loadPopoverTheme(this.popover, theme);
  }

  /** Clicking the tray icon to CLOSE an open popover steals its focus first,
   *  which fires the `blur` listener's `hide()` before this click's own
   *  `toggle()` handler runs — without the `REOPEN_GUARD_MS` check below,
   *  `toggle()` would then see an already-hidden window and reopen it, so
   *  the click that was meant to close the popover instead does nothing (or
   *  flickers). Any click within that window of a blur-triggered hide is
   *  treated as "that hide already satisfied this click's intent" and
   *  skipped. */
  private toggle(): void {
    if (this.popover && this.popover.isVisible()) {
      this.hide();
      return;
    }
    if (Date.now() - this.lastHideAt < TrayController.REOPEN_GUARD_MS) return;
    this.show();
  }

  private hide(): void {
    this.lastHideAt = Date.now();
    if (this.popover && !this.popover.isDestroyed()) this.popover.hide();
  }

  private show(): void {
    if (!this.tray) return;
    const theme = this.deps.getEffectiveTheme();
    const win = this.popover ?? this.createPopover(theme);
    // The popover `BrowserWindow` is cached and reused across opens (see
    // `createPopover()`'s own comment), so a theme switch made while it was
    // hidden wouldn't otherwise show up until `syncTheme()` next runs — this
    // catches that stale case on every reopen too, not just a live change
    // while already visible.
    if (this.popover && theme !== this.popoverTheme) this.loadPopoverTheme(win, theme);
    this.popover = win;
    this.positionUnderTray(win);
    // showInactive(), not show()+focus(): the latter activates the whole app
    // on macOS, and activating any window of an app that has another window
    // in native fullscreen forces that window out of its fullscreen Space.
    // showInactive() shows the popover without activating the app, so the
    // main garden window's fullscreen state is left alone. `acceptFirstMouse`
    // on the popover's BrowserWindow (see `createPopover()`) keeps its
    // buttons clickable on the very first click despite not being key/focused
    // on open.
    win.showInactive();
    //
    // No data push here — see `init()`'s `tray:getData` handler comment. The
    // page's own `visibilitychange` listener does the pulling once `show()`
    // actually makes it visible.
  }

  private createPopover(theme: 'light' | 'dark'): BrowserWindow {
    const win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false, // the panel draws its own hard-offset shadow (CSS) — see trayPopoverHtml.ts
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Since the popover opens via showInactive() (not key/focused), a
      // click on it would otherwise just activate the window without
      // reaching its contents — acceptFirstMouse (macOS-only) makes that
      // first click also click through to the web contents.
      acceptFirstMouse: true,
      webPreferences: {
        preload: join(__dirname, '../preload/trayPopoverPreload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 'pop-up-menu' is the conventional always-on-top level for exactly this
    // shape of window (a tray's own popup panel) — the constructor's plain
    // `alwaysOnTop: true` above only gets the default 'floating' level.
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.on('blur', () => this.hide());
    win.on('closed', () => {
      if (this.popover === win) this.popover = null;
    });
    // This window only ever shows its own fixed, self-authored data: URL
    // (never remote/user content), but it's cheap defense-in-depth to
    // foreclose it from ever opening a new window (same guard createWindow()
    // already applies to the main window in index.ts) or navigating anywhere
    // else — `will-navigate` doesn't fire for the `loadURL` call below (that
    // API only covers navigations a PAGE initiates afterward, e.g. a script
    // reassigning `window.location`), so this doesn't block the popover's
    // own initial load.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.loadPopoverTheme(win, theme);
    return win;
  }

  /** Loads (or reloads) `win` with `buildTrayPopoverHtml(theme)` and records
   *  `theme` as `popoverTheme` — the one place that builds the popover's
   *  document, shared by both initial creation and a later theme-driven
   *  reload (`show()`, `syncTheme()`). A full `loadURL()` re-run rather than
   *  a live DOM patch — see trayPopoverHtml.ts's own comment on
   *  `buildTrayPopoverHtml` for why that's cheap enough here. */
  private loadPopoverTheme(win: BrowserWindow, theme: 'light' | 'dark'): void {
    this.popoverTheme = theme;
    void win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buildTrayPopoverHtml(theme))}`);
  }

  /** Anchors the popover under the tray icon — `tray.getBounds()` for the
   *  icon's own screen position, clamped so the panel never renders
   *  partially off the display it's on (an icon near the right edge of a
   *  wide/multi-monitor menu bar would otherwise push the window's right
   *  edge past the screen). */
  private positionUnderTray(win: BrowserWindow): void {
    if (!this.tray) return;
    const trayBounds = this.tray.getBounds();
    const display = screen.getDisplayMatching(trayBounds);
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2);
    x = Math.min(Math.max(x, display.workArea.x), display.workArea.x + display.workArea.width - WINDOW_WIDTH);
    const y = Math.round(trayBounds.y + trayBounds.height);
    win.setBounds({ x, y, width: WINDOW_WIDTH, height: POPOVER_HEIGHT });
  }

  private async collectData(): Promise<TrayPopoverData> {
    const [usage, costHistory] = await Promise.all([
      this.deps.usageService.refreshNow(),
      this.deps.costHistory.getSnapshot()
    ]);
    return { usage, costHistory, sessions: countSessions(this.deps.getSessionRegistry()) };
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
