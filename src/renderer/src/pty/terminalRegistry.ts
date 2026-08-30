/**
 * One xterm Terminal + one PTY subscription + one output parser per session,
 * held OUTSIDE React.
 *
 * Written fresh (the upstream app puts this in a React component). It lives here
 * because the garden must keep reacting to agent output while the terminal
 * drawer is closed, and because scrollback should survive switching tabs.
 *
 * WebGL budget: `@xterm/addon-webgl` takes a WebGL context per terminal and Pixi
 * holds one of its own; Chromium evicts the oldest context once enough are live
 * (which is exactly how the upstream app's floor would go blank). So the WebGL
 * addon is attached only to the terminal that is actually on screen, and torn
 * down on detach.
 */
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { createPtyParser, type PtyParser } from './ptyParser';
import { handleHookEvent } from './hookRouter';
import { resetLoopStreak } from './loopDetector';
import { useStore } from '@/store/store';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { bumpCounter } from '@/diagnosticsCounters';
import { GARDEN_SPLIT_DRAG_END_EVENT } from '@/gardenSplit';
import {
  accentLight,
  dangerLight,
  ground,
  groundLight,
  ink,
  inkLight,
  primaryAccent,
  primaryAccentLight,
  type as textType,
  type EffectiveTheme
} from '@/design/tokens';
import type { AgentProviderId } from '@shared/agentProvider';
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '@shared/terminalTypes';

// Terminal type: JetBrains Mono at the spec's mono-md step (14/20 — see
// design/tokens.ts). xterm's own `fontFamily`/`fontSize`/`lineHeight` are a
// plain constructor option object, not CSS, so they can't read the
// `--font-mono-*` custom properties applyTokens() sets — same rationale
// tokens.ts's own header gives for THEME below. `lineHeight` here is a
// multiplier of `fontSize`, not px, hence the division. `fontSize` and
// `scrollback` (Phase 8.5 Wave B item 3) are the settings-panel-adjustable
// two — `currentSettings` holds whatever was last hydrated/changed, and every
// NEW terminal is constructed from it; `applyTerminalSettings` pushes a
// change onto every terminal already alive.
const TERMINAL_FONT_FAMILY = `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
const TERMINAL_LINE_HEIGHT = textType.monoMd.line / textType.monoMd.size;
let currentSettings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;

/** How long a plain-shell session (no hooks, no regex parser — see
 *  createTerminal below) may go quiet before its walker naps. Item 3 §3's
 *  "pty output bytes in last 30s" heuristic. */
const SHELL_NAP_AFTER_MS = 30_000;
const SHELL_NAP_CHECK_MS = 5_000;

// Pulled from design/tokens.ts (Phase 8 §2) rather than hardcoded — xterm's
// theme is a plain JS object, not CSS, so it can't read the :root custom
// properties applyTokens() sets; tokens.ts is the non-CSS consumer path for
// exactly this (see that file's own header, and munder-difflin's tokens.ts,
// which states the same rationale for its Pixi.js consumers).
//
// Dark theme is unchanged from before light-mode terminal theming existed —
// no ANSI palette entries, xterm's own defaults (already tuned for a dark
// background) are what every session has always rendered with.
const DARK_THEME: ITheme = {
  background: ground[0],
  foreground: ink[900],
  cursor: primaryAccent,
  selectionBackground: ground[200]
};

// Light theme (theme settings addendum) — xterm has no ANSI-16 default that
// works on a light background (several of its defaults are near-invisible
// on cream), so every slot below is explicit. Reuses the light accent ramp
// from tokens.ts wherever a hue already exists there; `cyan` has no
// dedicated token (tokens.ts's accent set doesn't have one) so it's hand-
// picked for legibility against `groundLight.terminal`, same as `yellow`
// (goldLight's own contrast caveat, documented in tokens.ts, rules it out
// as ANSI text on this background).
const LIGHT_THEME: ITheme = {
  background: groundLight.terminal,
  foreground: inkLight[900],
  cursor: primaryAccentLight,
  cursorAccent: groundLight.terminal,
  // `groundLight[200]` (a light cream tint) reads as nearly invisible
  // against `groundLight.terminal` — `disabled` carries real contrast.
  selectionBackground: groundLight.disabled,
  black: inkLight[900],
  red: dangerLight,
  green: accentLight.mint,
  yellow: '#9C7A1E',
  blue: accentLight.sky,
  magenta: accentLight.lilac,
  cyan: '#2F7480',
  white: inkLight[700],
  brightBlack: inkLight[500],
  brightRed: accentLight.coral,
  brightGreen: accentLight.mint,
  brightYellow: '#9C7A1E',
  brightBlue: accentLight.sky,
  brightMagenta: accentLight.lilac,
  brightCyan: '#2F7480',
  brightWhite: inkLight[900]
};

/** Theme applied to every terminal — new (via `createTerminal`) and already-
 *  mounted (via `applyTerminalTheme` below). Defaults dark, matching the
 *  app's own pre-first-paint dark default (main.tsx's `applyTheme('dark')`
 *  call, before the persisted setting resolves). */
let currentTheme: ITheme = DARK_THEME;

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webgl: WebglAddon | null;
  /** Stable host element: xterm renders into this once, and we move IT around
   *  the DOM rather than re-opening the terminal on every mount. */
  host: HTMLDivElement;
  /** Null for a plain-shell session (item 3 §3) — no agent CLI output to
   *  scrape, and scraping shell text risks a stray "● Task(" triggering a
   *  battle signal, which plain shells must never do. */
  parser: PtyParser | null;
  provider: AgentProviderId;
  offData: () => void;
  offExit: () => void;
  offHook: () => void;
  offCost: () => void;
  resizeObserver: ResizeObserver | null;
  /** Set exactly while attached (alongside `resizeObserver`) — removed on
   *  detach. See the `GARDEN_SPLIT_DRAG_END_EVENT` listener in
   *  attachTerminal for what it's for. */
  offDragEnd: (() => void) | null;
}

const entries = new Map<string, Entry>();

/** Last time a plain-shell session's PTY emitted output — item 3 §3's nap
 *  heuristic input. Only populated for provider `'shell'` entries. */
const shellLastActivity = new Map<string, number>();
let shellNapInterval: ReturnType<typeof setInterval> | null = null;

/** Poll (not push) the 30s-quiet check: a single shared interval, started
 *  lazily on the first shell session and left running (checking an empty map
 *  is cheap, and there is no lifecycle event for "no plain shells left" worth
 *  wiring a teardown for). */
function ensureShellNapWatch(): void {
  if (shellNapInterval) return;
  shellNapInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActivity] of shellLastActivity) {
      const napping = now - lastActivity >= SHELL_NAP_AFTER_MS;
      const session = useStore.getState().sessions.find((s) => s.id === id);
      if (session && !!session.napping !== napping) {
        useStore.getState().updateSession(id, { napping });
      }
    }
  }, SHELL_NAP_CHECK_MS);
}

/** Create the terminal and start consuming the PTY. Call right after spawn,
 *  or (`replay`) on boot to re-adopt a session whose PTY survived a renderer
 *  crash/reload — see main/index.ts's `sessions:restore`. `replay` is written
 *  AFTER the live PTY listener below is wired, not before: xterm buffers
 *  writes made before `attach()`'s `term.open()` internally regardless of
 *  order, but attaching the listener first means any bytes the PTY emits
 *  between the main-process snapshot (`getReplay`) and this call still land
 *  in the terminal instead of being lost in the gap.
 *
 *  `provider` (item 3 §3) picks the parser: every provider except `'shell'`
 *  gets the usual regex-fallback parser; a plain shell gets none — see the
 *  `Entry.parser` field comment for why. */
export function createTerminal(sessionId: string, provider: AgentProviderId, replay?: string): void {
  if (entries.has(sessionId)) return;

  const term = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: currentSettings.fontSize,
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: currentSettings.scrollback,
    theme: currentTheme
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  // xterm needs a laid-out parent to measure against, so open() happens on
  // attach(); until then the terminal buffers writes internally.

  // `let`, not `const`: a BUG/UX-fix fallback shell (PtyExit.fallback, below)
  // drops this to null so `offData` stops feeding it — see that branch's own
  // comment for why.
  let parser = provider === 'shell' ? null : createPtyParser(sessionId);
  if (provider === 'shell') {
    shellLastActivity.set(sessionId, Date.now());
    ensureShellNapWatch();
  }

  const offData = window.api.onPtyData(sessionId, (data) => {
    term.write(data);
    parser?.push(data);
    if (provider === 'shell') shellLastActivity.set(sessionId, Date.now());
  });

  const offExit = window.api.onPtyExit(sessionId, ({ exitCode, fallback }) => {
    parser?.dispose();
    if (fallback) {
      // main is replacing this pty with a plain fallback shell (BUG/UX fix
      // — see PtyExit.fallback's own comment) riding the SAME `pty:data:<id>`
      // channel `offData` above reads. `dispose()` above already cleared
      // this session's hook-authority tracking (hookRouter.ts's
      // clearHookAuthority), so without nulling the reference here the very
      // next byte from that shell would fall through to full regex scraping
      // — the exact hazard the `provider === 'shell'` branch above exists to
      // avoid for a plain-shell session from birth (see `Entry.parser`'s own
      // comment). Once dropped it stays dropped: nothing in this app resumes
      // a 'done' session's CLI in place, so there's no path that would need
      // a parser back.
      parser = null;
    }
    term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    useStore.getState().updateSession(sessionId, {
      status: 'done',
      exitCode,
      tool: undefined,
      toolTarget: undefined,
      station: 'wander'
    });
  });

  term.onData((data) => {
    // The user typing into this session's terminal is a "steer" — the loop
    // breaker's other reset trigger besides a different tool+target
    // (Phase 8.5 #3).
    resetLoopStreak(sessionId);
    void window.api.writePty(sessionId, data);
  });

  // Phase 4 Part A — a no-op subscription for non-claude providers (main
  // never emits on this channel for them), authoritative for claude once its
  // first hook fires. See hookRouter.ts.
  const offHook = window.api.onHookEvent(sessionId, (evt) => {
    try {
      handleHookEvent(sessionId, evt);
    } catch (err) {
      // A throw anywhere in the hook-handling chain (battle spawn/attack
      // path included) must never take down this subscription or silently
      // vanish — see the forensic writeup on v1.1.0's disappearing
      // subagent-battle spawns.
      bumpCounter('hookEventsDropped');
      safeLogDiagnostic('hook-router', 'error', 'handleHookEvent threw', {
        sessionId,
        event: evt.event,
        tool: evt.tool,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }
  });

  // Phase 8.5 Wave B item 1 — same no-op-for-non-claude shape as offHook
  // above: main only ever registers a transcript (and therefore only ever
  // emits on this channel) for a claude-provider session, or a session a
  // test explicitly pointed at a synthetic transcript via
  // `registerCostTestPath`.
  const offCost = window.api.onCostUpdate(sessionId, (update) => {
    // Session-status statusline strip's "↺ changed from <prev>" tick
    // (session-status feature) — diff the incoming model against the
    // PREVIOUS update's model (not the tick's own prior value) so a change
    // is only ever detected once, right when it happens; `modelChangedFrom`
    // itself then persists unedited across every later update whose model
    // matches the new one, per the tick's own "stays until next change"
    // spec. Skipped on the very first update for a session (`prevModel`
    // undefined) — that's this session's baseline model, not a change.
    const session = useStore.getState().sessions.find((s) => s.id === sessionId);
    const prevModel = session?.cost?.model;
    const isPlaceholderModel = (model: string | null | undefined): boolean =>
      model !== null && model !== undefined && /^<[^>]+>$/.test(model);
    const storedModelChangedFrom = isPlaceholderModel(session?.modelChangedFrom)
      ? undefined
      : session?.modelChangedFrom;
    const modelChangedFrom =
      isPlaceholderModel(prevModel) || isPlaceholderModel(update.model)
        ? storedModelChangedFrom
        : prevModel && update.model && update.model !== prevModel
          ? prevModel
          : storedModelChangedFrom;
    useStore.getState().updateSession(sessionId, { cost: update, modelChangedFrom });
  });

  entries.set(sessionId, {
    id: sessionId,
    term,
    fit,
    search,
    webgl: null,
    host,
    parser,
    provider,
    offData,
    offExit,
    offHook,
    offCost,
    resizeObserver: null,
    offDragEnd: null
  });

  if (replay) term.write(replay);
}

/** Mount the session's terminal into `parent` and start tracking its size. */
export function attachTerminal(sessionId: string, parent: HTMLElement): void {
  const e = entries.get(sessionId);
  if (!e) return;

  parent.appendChild(e.host);
  if (!e.host.querySelector('.xterm')) e.term.open(e.host);

  if (!e.webgl) {
    try {
      const webgl = new WebglAddon();
      // Chromium can still evict this context under pressure; fall back quietly.
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (e.webgl === webgl) e.webgl = null;
      });
      e.term.loadAddon(webgl);
      e.webgl = webgl;
    } catch {
      // No WebGL available — xterm's DOM renderer still works fine.
      e.webgl = null;
    }
  }

  // While the garden/terminal split is being dragged (`body.is-splitting`,
  // toggled by GardenSplitHandle.tsx), `parent`'s width changes on every
  // rAF-throttled tick the drag produces, firing this ResizeObserver at the
  // same cadence. `fit.fit()` reflows xterm's own DOM/WebGL layers, and
  // `resizePty` IPCs a SIGWINCH to the live CLI — sat together, running
  // both dozens of times a second is enough to fire Chromium's own
  // "ResizeObserver loop completed with undelivered notifications"
  // warnings, on top of making a full-screen TUI redraw for no reason. Skip
  // both for the whole drag — CSS reflow alone keeps the terminal's DOM
  // filling `parent`, just with a stale cell grid until the drag ends — and
  // let the drag-end listener below do one real fit the instant it does.
  const doFit = (): void => {
    if (document.body.classList.contains('is-splitting')) return;
    try {
      e.fit.fit();
      void window.api.resizePty(sessionId, e.term.cols, e.term.rows);
    } catch {
      /* element not laid out yet */
    }
  };
  doFit();

  e.resizeObserver = new ResizeObserver(doFit);
  e.resizeObserver.observe(parent);
  const onSplitDragEnd = (): void => {
    requestAnimationFrame(doFit);
  };
  window.addEventListener(GARDEN_SPLIT_DRAG_END_EVENT, onSplitDragEnd);
  e.offDragEnd = () => window.removeEventListener(GARDEN_SPLIT_DRAG_END_EVENT, onSplitDragEnd);
}

/** Unmount from the DOM and give the WebGL context back. Scrollback is kept. */
export function detachTerminal(sessionId: string): void {
  const e = entries.get(sessionId);
  if (!e) return;
  e.resizeObserver?.disconnect();
  e.resizeObserver = null;
  e.offDragEnd?.();
  e.offDragEnd = null;
  if (e.webgl) {
    try {
      e.webgl.dispose();
    } catch {
      /* already gone */
    }
    e.webgl = null;
  }
  e.host.remove();
}

export function focusTerminal(sessionId: string): void {
  entries.get(sessionId)?.term.focus();
}

/** Tear everything down. Call after killing the PTY. */
export function disposeTerminal(sessionId: string): void {
  const e = entries.get(sessionId);
  if (!e) return;
  detachTerminal(sessionId);
  e.offData();
  e.offExit();
  e.offHook();
  e.offCost();
  e.parser?.dispose();
  e.term.dispose();
  entries.delete(sessionId);
  shellLastActivity.delete(sessionId);
}

export function hasTerminal(sessionId: string): boolean {
  return entries.has(sessionId);
}

/** First-class delegate sessions (shared/delegateSpawn.ts) — writes a replay
 *  snapshot into an ALREADY-created (already-subscribed) terminal, unlike
 *  `createTerminal`'s own `replay` param (written before its live listener
 *  attaches, for a session whose pty predates this app process — see
 *  `sessions:restore`). A delegate's pty is already running by the time the
 *  renderer hears about it at all, so its terminal is created and subscribed
 *  FIRST (no gap), then this backfills whatever arrived before that — see
 *  sessions.ts's `startDelegateSpawnListener` for the full sequencing
 *  rationale. No-op for an unknown/already-torn-down session id. */
export function writeReplayNow(sessionId: string, data: string): void {
  const term = entries.get(sessionId)?.term;
  if (!term) return;
  // `write` may process a larger replay on its next xterm turn. Scroll in its
  // completion callback so the newly-created delegate terminal is at the
  // bottom after the backlog is actually present; live output then continues
  // from the normal follow-output position.
  term.write(data, () => term.scrollToBottom());
}

// ─── Find-in-scrollback (Phase 8.5 Wave B item 3 §1) ───────────────────────
// Cmd+F opens a find bar (TerminalFindBar.tsx) over the visible terminal;
// these just forward to that session's own SearchAddon instance.

const SEARCH_OPTS: ISearchOptions = { incremental: false };

export function searchNext(sessionId: string, term: string): void {
  entries.get(sessionId)?.search.findNext(term, SEARCH_OPTS);
}

export function searchPrevious(sessionId: string, term: string): void {
  entries.get(sessionId)?.search.findPrevious(term, SEARCH_OPTS);
}

export function clearSearch(sessionId: string): void {
  entries.get(sessionId)?.search.clearDecorations();
}

// ─── Terminal settings (Phase 8.5 Wave B item 3 §2) ────────────────────────

/** Apply font size / scrollback to every live terminal (new AND already-
 *  mounted), and re-fit the currently attached one so its cols/rows — and
 *  therefore the PTY's own idea of the terminal size — stay in sync with the
 *  new glyph metrics. Also banks `settings` as the default for any terminal
 *  created after this call. */
/** Apply the light/dark terminal theme to every live terminal (new AND
 *  already-mounted), live — theme settings addendum: switching themes must
 *  recolor open terminals, not just ones created afterward. Also banks the
 *  theme as the default for any terminal created after this call (mirrors
 *  `applyTerminalSettings` below). A terminal with the WebGL renderer
 *  attached can keep stale glyph colors in its texture atlas after a plain
 *  `options.theme` assignment until its next paint — `term.refresh()` forces
 *  that repaint immediately instead of waiting on the next PTY byte. */
export function applyTerminalTheme(mode: EffectiveTheme): void {
  currentTheme = mode === 'light' ? LIGHT_THEME : DARK_THEME;
  for (const e of entries.values()) {
    e.term.options.theme = currentTheme;
    if (e.term.rows > 0) e.term.refresh(0, e.term.rows - 1);
  }
}

export function applyTerminalSettings(settings: TerminalSettings): void {
  currentSettings = settings;
  for (const e of entries.values()) {
    e.term.options.fontSize = settings.fontSize;
    e.term.options.scrollback = settings.scrollback;
    // Only an ATTACHED terminal has a laid-out parent to fit against —
    // `resizeObserver` is set exactly while attached (see attachTerminal/
    // detachTerminal above).
    if (e.resizeObserver) {
      try {
        e.fit.fit();
        void window.api.resizePty(e.id, e.term.cols, e.term.rows);
      } catch {
        /* element not laid out yet */
      }
    }
  }
}
