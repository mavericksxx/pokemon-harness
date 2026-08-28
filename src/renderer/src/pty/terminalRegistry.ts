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
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { createPtyParser, type PtyParser } from './ptyParser';
import { handleHookEvent } from './hookRouter';
import { useStore } from '@/store/store';
import { ground, ink, primaryAccent, type as textType } from '@/design/tokens';
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
const THEME = {
  background: ground[0],
  foreground: ink[900],
  cursor: primaryAccent,
  selectionBackground: ground[200]
};

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
  resizeObserver: ResizeObserver | null;
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
    theme: THEME
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

  const parser = provider === 'shell' ? null : createPtyParser(sessionId);
  if (provider === 'shell') {
    shellLastActivity.set(sessionId, Date.now());
    ensureShellNapWatch();
  }

  const offData = window.api.onPtyData(sessionId, (data) => {
    term.write(data);
    parser?.push(data);
    if (provider === 'shell') shellLastActivity.set(sessionId, Date.now());
  });

  const offExit = window.api.onPtyExit(sessionId, ({ exitCode }) => {
    parser?.dispose();
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
    void window.api.writePty(sessionId, data);
  });

  // Phase 4 Part A — a no-op subscription for non-claude providers (main
  // never emits on this channel for them), authoritative for claude once its
  // first hook fires. See hookRouter.ts.
  const offHook = window.api.onHookEvent(sessionId, (evt) => handleHookEvent(sessionId, evt));

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
    resizeObserver: null
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

  const doFit = (): void => {
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
}

/** Unmount from the DOM and give the WebGL context back. Scrollback is kept. */
export function detachTerminal(sessionId: string): void {
  const e = entries.get(sessionId);
  if (!e) return;
  e.resizeObserver?.disconnect();
  e.resizeObserver = null;
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
  e.parser?.dispose();
  e.term.dispose();
  entries.delete(sessionId);
  shellLastActivity.delete(sessionId);
}

export function hasTerminal(sessionId: string): boolean {
  return entries.has(sessionId);
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
