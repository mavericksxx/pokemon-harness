/**
 * Tray popover page (issue #17) — the ENTIRE document for the menu-bar
 * popover `BrowserWindow` (see tray.ts's own header), as one self-contained
 * HTML string loaded via `loadURL('data:text/html...')`. Not part of the
 * main renderer's React app or its electron-vite `renderer` build target —
 * a deliberately small, dependency-free page (plain DOM, no framework, no
 * bundler step) that only needs `window.trayApi` (trayPopoverPreload.ts)
 * for data.
 *
 * A data: URL (rather than a shipped .html asset) sidesteps every asset-
 * packaging question a separate file would raise (electron-vite's `main`
 * build target doesn't copy arbitrary static files, and electron-builder's
 * `files` glob only picks up `out/**`) — this string compiles straight into
 * the main bundle, so it's guaranteed present wherever `out/main/index.js`
 * runs, dev or packaged, no extra resource wiring.
 *
 * Visual language matches the main app's existing "trainer card" chrome
 * (UsageChip.tsx's popover, design/tokens.ts) — same panel/border/text
 * colors, same hard-edged HP-bar gauge treatment, same gauge-tone
 * thresholds — with hex values copied in directly rather than imported
 * (this file has no build step to resolve a TS/CSS import through), for
 * BOTH the dark and light palettes (`DARK_PALETTE`/`LIGHT_PALETTE` below,
 * matched by hand against `design/tokens.ts`'s dark constants and their
 * `*Light` counterparts). `buildTrayPopoverHtml(theme)` picks one at
 * document-build time — see tray.ts's own header for how the caller decides
 * which theme to build and when to rebuild an already-open popover. The one
 * deliberate departure: no self-hosted Press Start 2P pixel font — shipping
 * that font to a page outside the renderer's own asset pipeline is real
 * packaging work for a decorative typeface, so section headers use a plain
 * uppercase monospace treatment instead. See tray.ts's header for the fuller
 * tradeoff note.
 */

/** One theme's worth of hex values for every color used in `STYLE` below.
 *  Field names describe the ROLE the color plays (matching a design/tokens.ts
 *  constant), not the literal dark hex, so `LIGHT_PALETTE` reads as "the
 *  light counterpart of each dark role" rather than a second unrelated list. */
interface TrayPopoverPalette {
  colorScheme: 'light' | 'dark';
  /** design/tokens.ts `ground[100]` / `groundLight[100]` — panel fill. */
  panel: string;
  /** `ground[300]` / `groundLight[300]` — hairline borders. */
  border: string;
  /** `ink[900]` / `inkLight[900]` — primary text. */
  text: string;
  /** `gold` / `goldLight` — brand accent (section headers, pokéball, sparkline bars). */
  accent: string;
  /** `ink[300]` / `inkLight[300]` — subtle section/provider dividers. */
  divider: string;
  /** `ink[500]` / `inkLight[500]` — muted/tertiary text. */
  muted: string;
  /** `ink[700]` / `inkLight[700]` — secondary text (provider headers). */
  mutedStrong: string;
  /** `ground.terminal` / `groundLight.terminal` — gauge track fill. */
  barTrack: string;
  /** `status.done` / `statusLight.done` — default (low-usage) gauge fill. */
  statusDone: string;
  /** `status.working` / `statusLight.working` — mid-usage gauge fill, "working" session dot. */
  statusWarn: string;
  /** `status.blocked` / `statusLight.blocked` — high-usage gauge fill, "needs you" session dot. */
  statusDanger: string;
  /** `status.idle` / `statusLight.idle` — "idle" session dot. */
  statusIdle: string;
  /** `ground.disabled` / `groundLight.disabled` — zero-cost sparkline bars. */
  disabled: string;
  /** `shadowHard` / `shadowHardLight` — the frame's hard-offset shadow. */
  shadow: string;
}

const DARK_PALETTE: TrayPopoverPalette = {
  colorScheme: 'dark',
  panel: '#1D1D22',
  border: '#787684',
  text: '#DEDBD6',
  accent: '#E8B740',
  divider: '#3E3D46',
  muted: '#96919F',
  mutedStrong: '#B3B0AC',
  barTrack: '#1A1A1F',
  statusDone: '#6FB88B',
  statusWarn: '#D8B052',
  statusDanger: '#DF8078',
  statusIdle: '#64ACBB',
  disabled: '#313139',
  shadow: '4px 4px 0 rgba(0, 0, 0, 0.45)'
};

const LIGHT_PALETTE: TrayPopoverPalette = {
  colorScheme: 'light',
  panel: '#FFF8E7',
  border: '#A899B5',
  text: '#1A1320',
  accent: '#DCAB3C',
  divider: '#D9CFE0',
  muted: '#6B5878',
  mutedStrong: '#3D2E4A',
  barTrack: '#FCFAF0',
  statusDone: '#5CA97A',
  statusWarn: '#DCAB3C',
  statusDanger: '#D96A62',
  statusIdle: '#4F9FAF',
  disabled: '#E8D9A0',
  shadow: '3px 3px 0 rgba(26, 19, 32, 0.14)'
};

function buildStyle(p: TrayPopoverPalette): string {
  return `
  :root { color-scheme: ${p.colorScheme}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    color: ${p.text};
    -webkit-user-select: none;
    user-select: none;
    overflow: hidden;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
  .frame {
    margin: 6px 10px 10px 6px; /* leaves room (top/right) for the hard-offset shadow below */
    background: ${p.panel};
    border: 1px solid ${p.border};
    border-radius: 2px;
    box-shadow: ${p.shadow};
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 16px);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid ${p.border};
    flex: 0 0 auto;
  }
  .header .ball {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: ${p.text};
    position: relative;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .header .ball::before {
    content: '';
    position: absolute;
    inset: 0 0 50% 0;
    background: ${p.accent};
  }
  .header .ball::after {
    content: '';
    position: absolute;
    top: calc(50% - 1px);
    left: 0;
    right: 0;
    height: 2px;
    background: ${p.panel};
  }
  .header .brand {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: ${p.text};
  }
  .body {
    overflow-y: auto;
    padding: 10px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  section + section {
    padding-top: 12px;
    border-top: 1px solid ${p.divider};
  }
  .section-head {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: ${p.accent};
    margin: 0 0 8px;
  }
  .muted { color: ${p.muted}; }
  .provider + .provider { margin-top: 10px; padding-top: 10px; border-top: 1px solid ${p.divider}; }
  .provider-head { font-size: 11px; font-weight: 600; color: ${p.mutedStrong}; margin-bottom: 6px; }
  .window + .window { margin-top: 6px; }
  .window-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
    color: ${p.muted};
  }
  .window-label { text-transform: lowercase; }
  .window-pct { color: ${p.text}; font-weight: 600; }
  .bar {
    height: 8px;
    padding: 1px;
    margin-top: 3px;
    background: ${p.barTrack};
    border: 1px solid ${p.border};
    border-radius: 0;
  }
  .bar-fill {
    height: 100%;
    background-color: ${p.statusDone};
    background-image: repeating-linear-gradient(to right, rgba(0,0,0,0.22) 0 1px, transparent 1px 4px);
    transform-origin: left center;
  }
  .bar-fill.warn { background-color: ${p.statusWarn}; }
  .bar-fill.danger { background-color: ${p.statusDanger}; }
  .window-foot { font-size: 10px; color: ${p.muted}; margin-top: 3px; }
  .balance { font-size: 10px; color: ${p.muted}; margin-top: 3px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11px; }
  .row + .row { margin-top: 4px; }
  .row .k { color: ${p.muted}; }
  .row .v { color: ${p.text}; font-weight: 600; }
  .stat-cluster { display: flex; gap: 14px; }
  .stat { display: flex; align-items: center; gap: 5px; font-size: 11px; }
  .stat-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
  .stat-dot.working { background: ${p.statusWarn}; }
  .stat-dot.idle { background: ${p.statusIdle}; }
  .stat-dot.needsYou { background: ${p.statusDanger}; }
  .stat b { color: ${p.text}; }
  .spark {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 34px;
    margin-top: 8px;
  }
  .spark-bar {
    flex: 1 1 0;
    min-width: 2px;
    background: ${p.accent};
    border-radius: 0;
  }
  .spark-bar.zero { background: ${p.disabled}; height: 2px !important; }
  </style>`;
}

// Inline JS. Deliberately no template literals / backticks anywhere below
// (this whole page is itself embedded in a TS template literal in
// trayPopoverHtml.ts's export — see this file's own header) — plain string
// concatenation instead, so nothing here needs escaping against the outer
// literal. Theme-independent — never touches a color — so it's built once,
// not per-palette like `buildStyle` above.
const SCRIPT = `
  var PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex CLI' };

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function gaugeTone(pct) {
    if (pct >= 80) return 'danger';
    if (pct >= 50) return 'warn';
    return 'normal';
  }

  function fmtResetIn(resetsAt, now) {
    if (resetsAt == null) return null;
    var diffMs = resetsAt - now;
    if (diffMs <= 0) return 'resets soon';
    var totalMin = Math.round(diffMs / 60000);
    var totalHours = Math.floor(totalMin / 60);
    if (totalHours < 1) return 'resets in ' + totalMin + 'm';
    if (totalHours < 24) return 'resets in ' + totalHours + 'h ' + (totalMin % 60) + 'm';
    var days = Math.floor(totalHours / 24);
    return 'resets in ' + days + 'd ' + (totalHours % 24) + 'h';
  }

  function fmtAgo(updatedAt, now) {
    if (!updatedAt) return '';
    var diffMin = Math.max(0, Math.round((now - updatedAt) / 60000));
    return diffMin <= 0 ? 'as of just now' : ('as of ' + diffMin + 'm ago');
  }

  function fmtUsd(n) {
    return '$' + (Math.round(n * 100) / 100).toFixed(2);
  }

  function fmtTokens(n) {
    if (n == null) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderWindow(w, now) {
    var wrap = el('div', 'window');
    if (w.balanceOnly) {
      var head0 = el('div', 'window-head');
      head0.appendChild(el('span', 'window-label', w.label));
      wrap.appendChild(head0);
      if (w.balanceText) wrap.appendChild(el('div', 'balance', w.balanceText));
      return wrap;
    }
    var tone = gaugeTone(w.usedPercent);
    var head = el('div', 'window-head');
    head.appendChild(el('span', 'window-label', w.label));
    head.appendChild(el('span', 'window-pct mono', Math.round(w.usedPercent) + '%'));
    wrap.appendChild(head);
    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill' + (tone !== 'normal' ? ' ' + tone : ''));
    fill.style.width = clamp(w.usedPercent, 0, 100) + '%';
    bar.appendChild(fill);
    wrap.appendChild(bar);
    var resetText = fmtResetIn(w.resetsAt, now);
    var footBits = [];
    if (resetText) footBits.push(resetText);
    if (w.spend) footBits.push(fmtUsd(w.spend.usedCents / 100) + ' / ' + fmtUsd(w.spend.limitCents / 100) + ' ' + w.spend.currency);
    if (footBits.length) wrap.appendChild(el('div', 'window-foot', footBits.join(' · ')));
    return wrap;
  }

  function renderProvider(p, now) {
    var wrap = el('div', 'provider');
    wrap.appendChild(el('div', 'provider-head', PROVIDER_LABEL[p.provider] || p.provider));
    if (p.state === 'ok') {
      p.windows.forEach(function (w) { wrap.appendChild(renderWindow(w, now)); });
      if (p.windows.length === 0) wrap.appendChild(el('div', 'muted', 'no usage windows reported'));
    } else if (p.state === 'stale') {
      wrap.appendChild(el('div', 'muted', (p.message || '') + ' · ' + fmtAgo(p.updatedAt, now)));
      p.windows.forEach(function (w) { wrap.appendChild(renderWindow(w, now)); });
    } else {
      wrap.appendChild(el('div', 'muted', p.message || 'usage unavailable'));
    }
    return wrap;
  }

  function renderUsage(usage, now) {
    var section = document.getElementById('usage-body');
    section.innerHTML = '';
    if (!usage || !usage.enabled) {
      section.appendChild(el('div', 'muted', 'usage limits are off — enable them in settings'));
      return;
    }
    if (!usage.providers || usage.providers.length === 0) {
      section.appendChild(el('div', 'muted', 'no usage data yet'));
      return;
    }
    usage.providers.forEach(function (p) { section.appendChild(renderProvider(p, now)); });
  }

  function renderSparkline(days) {
    var spark = el('div', 'spark');
    var max = 0;
    days.forEach(function (d) { if (d.costUsd > max) max = d.costUsd; });
    days.forEach(function (d) {
      var bar = el('div', 'spark-bar' + (d.costUsd <= 0 ? ' zero' : ''));
      var pct = max > 0 ? clamp((d.costUsd / max) * 100, 4, 100) : 0;
      bar.style.height = pct + '%';
      bar.title = d.date + ' · ' + fmtUsd(d.costUsd);
      spark.appendChild(bar);
    });
    return spark;
  }

  function renderCost(costHistory) {
    var section = document.getElementById('cost-body');
    section.innerHTML = '';
    if (!costHistory || !costHistory.days || costHistory.days.length === 0) {
      section.appendChild(el('div', 'muted', 'computing…'));
      return;
    }
    var r1 = el('div', 'row');
    r1.appendChild(el('span', 'k', 'today'));
    r1.appendChild(el('span', 'v mono', fmtUsd(costHistory.todayCostUsd)));
    section.appendChild(r1);
    var r2 = el('div', 'row');
    r2.appendChild(el('span', 'k', '30d cost'));
    r2.appendChild(el('span', 'v mono', fmtUsd(costHistory.last30dCostUsd)));
    section.appendChild(r2);
    var r3 = el('div', 'row');
    r3.appendChild(el('span', 'k', 'latest turn'));
    r3.appendChild(el('span', 'v mono', fmtTokens(costHistory.latestTurnTokens) + ' tok'));
    section.appendChild(r3);
    var r4 = el('div', 'row');
    r4.appendChild(el('span', 'k', '30d tokens'));
    r4.appendChild(el('span', 'v mono', fmtTokens(costHistory.last30dTokens)));
    section.appendChild(r4);
    if (costHistory.topModel) {
      var r5 = el('div', 'row');
      r5.appendChild(el('span', 'k', 'top model'));
      r5.appendChild(el('span', 'v mono', costHistory.topModel.model + ' (' + fmtTokens(costHistory.topModel.tokens) + ')'));
      section.appendChild(r5);
    }
    section.appendChild(renderSparkline(costHistory.days));
  }

  function renderSessions(sessions) {
    var section = document.getElementById('sessions-body');
    section.innerHTML = '';
    if (!sessions) return;
    var cluster = el('div', 'stat-cluster');
    var specs = [
      ['working', 'working', sessions.working],
      ['idle', 'idle', sessions.idle],
      ['needsYou', 'needs you', sessions.needsYou]
    ];
    specs.forEach(function (spec) {
      var stat = el('div', 'stat');
      var dot = el('span', 'stat-dot ' + spec[0]);
      stat.appendChild(dot);
      var label = el('span', null, spec[1] + ' ');
      var count = el('b', null, String(spec[2]));
      label.appendChild(count);
      stat.appendChild(label);
      cluster.appendChild(stat);
    });
    section.appendChild(cluster);
  }

  var lastData = null;

  function renderAll() {
    var now = Date.now();
    if (lastData) {
      renderUsage(lastData.usage, now);
      renderCost(lastData.costHistory);
      renderSessions(lastData.sessions);
    }
  }

  function refresh() {
    window.trayApi.getData().then(function (data) {
      lastData = data;
      renderAll();
    });
  }

  // Pull-based, not a push subscription (see trayPopoverPreload.ts's own
  // comment for why): fetch once right now (covers the very first load —
  // this inline script only ever runs ONCE for the popover's whole
  // lifetime, since tray.ts shows/hides the SAME window rather than
  // recreating it per open), and again every time this page's own
  // visibility flips to visible (covers every open after the first —
  // tray.ts's show()/hide() toggle this window's OS-level visibility, which
  // Chromium surfaces here as a normal Page Visibility API transition).
  refresh();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  // Re-render every 30s even without fresh data — only the reset/"as of"
  // countdown text depends on wall-clock time, so this never re-fetches.
  setInterval(renderAll, 30000);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.trayApi.close();
  });
</script>`;

/** Builds the popover's whole document for one effective theme. Called by
 *  tray.ts both to create the popover `BrowserWindow` and to reload it in
 *  place when the effective theme changes while it already exists (see that
 *  file's own header) — a full `loadURL()` re-run rather than a live DOM
 *  patch, since this page has no CSS-custom-property indirection to flip and
 *  re-running the inline `<script>` is cheap (a `data:` URL, no network). */
export function buildTrayPopoverHtml(theme: 'light' | 'dark'): string {
  const palette = theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const style = buildStyle(palette);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>pokéharness</title>
<style>${style}
</head>
<body>
<div class="frame">
  <div class="header"><span class="ball"></span><span class="brand">pokéharness</span></div>
  <div class="body">
    <section>
      <div class="section-head">usage limits</div>
      <div id="usage-body"><div class="muted">loading…</div></div>
    </section>
    <section>
      <div class="section-head">cost — last 30 days</div>
      <div id="cost-body"><div class="muted">loading…</div></div>
    </section>
    <section>
      <div class="section-head">agents</div>
      <div id="sessions-body"><div class="muted">loading…</div></div>
    </section>
  </div>
</div>
<script>${SCRIPT}
</body>
</html>`;
}
