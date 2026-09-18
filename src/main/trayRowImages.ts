/**
 * Menu-bar row rasterizer — GitHub issue #17 follow-up, "option A" of the
 * approved tray redesign: every row that needs custom layout (a stacked
 * caption/value + HP bar, a section header, the cost sparkline, a
 * label/value stat) is drawn in the native `NSMenu` (tray.ts) as ONE image
 * containing both its text and its graphics, set as the `MenuItem`'s `icon`
 * with an empty label, so the row's layout can match the mockup
 * pixel-for-pixel instead of being constrained to "icon + native title
 * string" the first native-menu design used. The session-status row is the
 * one exception — it's plain native text (see tray.ts's own header for why)
 * and never passes through this file at all.
 *
 * WHY A HIDDEN WINDOW: the main process has no text-layout/rasterization API
 * of its own — `nativeImage` can only decode/compose pixels that already
 * exist, it can't shape or draw a glyph. A `<canvas>` 2D context can, but
 * that only exists inside a renderer. This file owns exactly one hidden,
 * never-shown `BrowserWindow` (lazily created, reused across every render —
 * see `TrayRowRenderer`) loaded from a self-contained `data:` HTML string
 * with an inline `<script>` that does nothing but draw rows on demand and
 * hand back PNG data URLs; there's no preload/contextBridge/IPC channel
 * wired up because `executeJavaScript` already runs directly in that page's
 * own JS context and can both pass a JSON payload in and read a JSON string
 * back out as its resolved value — a full IPC contract would be redundant
 * machinery for a call the main process itself triggers and awaits.
 *
 * `nativeImage.createFromDataURL` has no `scaleFactor` option (unlike
 * `createFromBuffer`), so a canvas drawn at `TRAY_ROW_SCALE`x and handed
 * back as a data URL would otherwise display at literally double point
 * size. `dataUrlToNativeImage` below strips the data-URL header, decodes
 * the base64 PNG bytes back into a `Buffer`, and re-wraps them with
 * `createFromBuffer(buf, { scaleFactor })` instead — `createFromBuffer`
 * accepts an already-PNG-encoded buffer directly (width/height are only
 * "required for bitmap buffers", per Electron's own type comment; an
 * encoded PNG carries its own dimensions), so this is a re-tag, not a
 * decode/re-encode round trip.
 *
 * Callers (tray.ts) own all the scheduling/caching/debounce policy around
 * *when* to call `render()` — this class only knows how to turn a batch of
 * `TrayRowSpec`s into `NativeImage`s, synchronously with respect to nothing
 * (it's `async` top to bottom) so it can never be on `openMenu()`'s
 * synchronous critical path.
 */
import { BrowserWindow, nativeImage, type NativeImage } from 'electron';
import type { TrayPalette } from './tray';

/** Every drawn row shares this content width so every row's left edge lines
 *  up in the menu — see tray.ts's own header for the NSMenu image-gutter
 *  finding this depends on. ~294pt matches the approved mockup's menu
 *  content width. */
const ROW_WIDTH_PT = 294;

/** Drawn at 2x and re-tagged with this as `createFromBuffer`'s
 *  `scaleFactor` (see this file's own header) — same Retina-crispness
 *  reasoning the deleted BGRA meter/sparkline painters used. */
export const TRAY_ROW_SCALE = 2;

/** One data row's draw instructions — a plain, JSON-serializable spec, never
 *  a rendered image itself. tray.ts decides in TypeScript everything that
 *  requires app knowledge (percent → tone → fill color, label text,
 *  formatting); this file's canvas script only knows how to lay out already
 *  -decided colors/strings/numbers, so none of the usage/cost threshold
 *  logic is duplicated in the injected JS. */
export type TrayRowSpec =
  | { kind: 'header'; left: string; right: string }
  | {
      kind: 'window';
      caption: string;
      value: string;
      bar: { filledSegments: number; totalSegments: number; fillColor: string } | null;
    }
  | { kind: 'sparkline'; bars: { heightFrac: number; color: string }[] }
  | { kind: 'stat'; label: string; value: string }
  | { kind: 'text'; text: string };

/** Stacked (caption/value + bar) rows are taller than every single-line
 *  kind; a `window` row without a bar (Codex's balance-only credits row)
 *  collapses to the single-line height instead. */
function rowHeightPt(spec: TrayRowSpec): number {
  if (spec.kind === 'window') return spec.bar ? 32 : 18;
  if (spec.kind === 'sparkline') return 26;
  return 18;
}

/** The hidden window's entire page — self-contained, no external resources,
 *  loaded once from a `data:` URL. `window.__trayRender` is the only thing
 *  `TrayRowRenderer.render` ever calls into it. Plain ES5-ish syntax
 *  throughout (`var`, no arrow functions) is deliberate, not a style choice:
 *  this string is never run through the app's own TypeScript/Babel/Vite
 *  pipeline, so it has to already be valid JS as written. */
const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script>
function trayFont(px, weight) {
  return weight + ' ' + px + 'px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif';
}

// Ellipsis truncation — every row's text goes through this rather than a
// bare fillText call, so a long provider/model name or usage message gets
// a trailing "..." instead of being silently clipped mid-glyph at the
// canvas edge. ctx.font must already be set to the font the text will
// actually draw with before calling this (it reads ctx.measureText, which
// is font-dependent) — every call site below sets ctx.font immediately
// before truncating for exactly that reason.
function truncateToWidth(ctx, text, maxWidth) {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  var ellipsis = '…';
  var avail = maxWidth - ctx.measureText(ellipsis).width;
  if (avail <= 0) return ellipsis;
  var lo = 0;
  var hi = text.length;
  while (lo < hi) {
    var mid = Math.ceil((lo + hi) / 2);
    var w = ctx.measureText(text.slice(0, mid)).width;
    if (w <= avail) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

// Shared left-caption/right-value line used by header/window/stat rows —
// the right side gets first claim on up to 45% of the row width (values are
// usually short: a percent, a dollar figure, a provider name), truncated to
// fit if not; the left side then gets whatever's left after that and a
// fixed gap, truncated the same way. Either side can be '' (e.g. a
// provider-only header row) with no special-casing needed — measuring/
// truncating/drawing an empty string is already a no-op.
function drawTwoSided(ctx, w, y, leftText, rightText, leftFont, leftColor, rightFont, rightColor, scale) {
  var gap = 8 * scale;
  ctx.font = rightFont;
  var rightTrunc = truncateToWidth(ctx, rightText, w * 0.45);
  var rightWidth = ctx.measureText(rightTrunc).width;
  ctx.font = leftFont;
  var leftTrunc = truncateToWidth(ctx, leftText, Math.max(0, w - rightWidth - gap));
  ctx.textBaseline = 'middle';
  ctx.fillStyle = leftColor;
  ctx.textAlign = 'left';
  ctx.fillText(leftTrunc, 0, y);
  ctx.font = rightFont;
  ctx.fillStyle = rightColor;
  ctx.textAlign = 'right';
  ctx.fillText(rightTrunc, w, y);
}

function drawHeader(ctx, w, h, spec, colors, scale) {
  drawTwoSided(ctx, w, h / 2, spec.left, spec.right, trayFont(12 * scale, '600'), colors.dim, trayFont(12 * scale, '400'), colors.dim, scale);
}

function drawSegmentedBar(ctx, w, top, barH, colors, bar, scale) {
  var n = bar.totalSegments;
  var gap = scale;
  var segW = Math.floor((w - gap * (n - 1)) / n);
  var x = 0;
  for (var i = 0; i < n; i++) {
    ctx.fillStyle = colors.border;
    ctx.fillRect(x, top, segW, barH);
    var innerX = x + scale;
    var innerY = top + scale;
    var innerW = Math.max(0, segW - 2 * scale);
    var innerH = Math.max(0, barH - 2 * scale);
    ctx.fillStyle = i < bar.filledSegments ? bar.fillColor : colors.track;
    ctx.fillRect(innerX, innerY, innerW, innerH);
    x += segW + gap;
  }
}

function drawWindow(ctx, w, h, spec, colors, scale) {
  var textY = spec.bar ? 8 * scale : h / 2;
  drawTwoSided(ctx, w, textY, spec.caption, spec.value, trayFont(13 * scale, '600'), colors.ink, trayFont(12 * scale, '400'), colors.dim, scale);
  if (spec.bar) {
    var barH = 9 * scale;
    drawSegmentedBar(ctx, w, h - barH, barH, colors, spec.bar, scale);
  }
}

function drawSparkline(ctx, w, h, spec, scale) {
  var n = Math.max(1, spec.bars.length);
  var gap = scale;
  var barW = Math.max(scale, Math.floor((w - gap * (n - 1)) / n));
  var x = 0;
  for (var i = 0; i < spec.bars.length; i++) {
    var bar = spec.bars[i];
    var barH = Math.max(2 * scale, Math.round(bar.heightFrac * h));
    ctx.fillStyle = bar.color;
    ctx.fillRect(x, h - barH, barW, barH);
    x += barW + gap;
  }
}

function drawStat(ctx, w, h, spec, colors, scale) {
  drawTwoSided(ctx, w, h / 2, spec.label, spec.value, trayFont(13 * scale, '400'), colors.ink, trayFont(12 * scale, '400'), colors.dim, scale);
}

function drawText(ctx, w, h, spec, colors, scale) {
  ctx.textBaseline = 'middle';
  ctx.font = trayFont(13 * scale, '400');
  ctx.fillStyle = colors.ink;
  ctx.textAlign = 'left';
  ctx.fillText(truncateToWidth(ctx, spec.text, w), 0, h / 2);
}

function renderOneRow(row, widthPt, scale, colors) {
  var w = Math.round(widthPt * scale);
  var h = Math.round(row.heightPt * scale);
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  var spec = row.spec;
  if (spec.kind === 'header') drawHeader(ctx, w, h, spec, colors, scale);
  else if (spec.kind === 'window') drawWindow(ctx, w, h, spec, colors, scale);
  else if (spec.kind === 'sparkline') drawSparkline(ctx, w, h, spec, scale);
  else if (spec.kind === 'stat') drawStat(ctx, w, h, spec, colors, scale);
  else if (spec.kind === 'text') drawText(ctx, w, h, spec, colors, scale);
  return canvas.toDataURL('image/png');
}

window.__trayRender = function (payloadJson) {
  var payload = JSON.parse(payloadJson);
  var out = [];
  for (var i = 0; i < payload.rows.length; i++) {
    out.push(renderOneRow(payload.rows[i], payload.widthPt, payload.scale, payload.colors));
  }
  return JSON.stringify(out);
};
</script>
</body>
</html>`;

/** Strips the `data:image/png;base64,` header and re-wraps the decoded PNG
 *  bytes as a properly Retina-tagged `NativeImage` — see this file's own
 *  header for why this goes through `createFromBuffer` instead of
 *  `createFromDataURL`. */
function dataUrlToNativeImage(dataUrl: string, scaleFactor: number): NativeImage {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return nativeImage.createFromBuffer(Buffer.from(base64, 'base64'), { scaleFactor });
}

/** Owns the one hidden `BrowserWindow` this feature needs, created lazily on
 *  the first `render()` call and reused for every call after — "don't keep
 *  re-creating it" (task spec). Never shown, never focusable, excluded from
 *  the Dock/Mission Control/Cmd+` cycling by construction (see the options
 *  below): it exists purely as a place to run a `<canvas>` 2D context, not
 *  as UI. */
export class TrayRowRenderer {
  private win: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) {
      if (this.loaded) await this.loaded;
      return this.win;
    }
    const win = new BrowserWindow({
      show: false,
      width: 10,
      height: 10,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // macOS: keeps this window out of the Dock and (per Electron's own
      // docs for this option) out of the window-switcher/Mission Control
      // surfaces a real, shown window would otherwise appear in — belt and
      // suspenders alongside `show: false`/never calling `.show()`, which
      // is what actually keeps it off-screen.
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        // Matches the main window's own security posture (index.ts's
        // `createWindow`) even though this page never loads untrusted
        // content — no reason for this one window to be the exception.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // This window is never visible/foregrounded, which is exactly the
        // condition Chromium's background-tab throttling targets; nothing
        // here uses a timer or rAF, but disabling it removes any chance of
        // an `executeJavaScript` call getting queued behind throttled work.
        backgroundThrottling: false
      }
    });
    this.win = win;
    this.loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`);
    await this.loaded;
    return win;
  }

  /** Renders every spec in one round trip to the hidden page and back —
   *  `async` throughout, never called from `openMenu()`'s synchronous path
   *  (see tray.ts). Returns `[]` (not a rejection) for an empty `specs`
   *  input, the only call shape tray.ts never actually makes but that costs
   *  nothing to handle correctly. */
  async render(specs: TrayRowSpec[], palette: TrayPalette): Promise<NativeImage[]> {
    if (specs.length === 0) return [];
    const win = await this.ensureWindow();
    if (win.isDestroyed()) return [];
    const payload = {
      scale: TRAY_ROW_SCALE,
      widthPt: ROW_WIDTH_PT,
      colors: { ink: palette.ink, dim: palette.dim, track: palette.track, border: palette.border },
      rows: specs.map((spec) => ({ spec, heightPt: rowHeightPt(spec) }))
    };
    // Double-`JSON.stringify`d: the outer one turns the payload into a JS
    // string LITERAL safe to splice into the injected code (handles every
    // quote/backslash/newline inside row text without hand-rolled escaping);
    // the page's own `JSON.parse` undoes exactly that one layer.
    const code = `window.__trayRender(${JSON.stringify(JSON.stringify(payload))})`;
    const resultJson = (await win.webContents.executeJavaScript(code)) as string;
    const dataUrls: string[] = JSON.parse(resultJson);
    return dataUrls.map((url) => dataUrlToNativeImage(url, TRAY_ROW_SCALE));
  }

  /** Synchronous, immediate teardown — `BrowserWindow.destroy()` (unlike
   *  `.close()`) never waits on `beforeunload`/`close` handlers, so this can
   *  never be what makes app quit hang. Called from `TrayController.destroy()`,
   *  which main/index.ts's `before-quit` already calls before `app.quit()`
   *  proceeds. */
  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loaded = null;
  }
}
