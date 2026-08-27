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
import '@xterm/xterm/css/xterm.css';
import { createPtyParser, type PtyParser } from './ptyParser';
import { useStore } from '@/store/store';

const THEME = {
  background: '#0d150e',
  foreground: '#d8e8d0',
  cursor: '#b5e48c',
  selectionBackground: '#2c4a2a'
};

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Stable host element: xterm renders into this once, and we move IT around
   *  the DOM rather than re-opening the terminal on every mount. */
  host: HTMLDivElement;
  parser: PtyParser;
  offData: () => void;
  offExit: () => void;
  resizeObserver: ResizeObserver | null;
}

const entries = new Map<string, Entry>();

/** Create the terminal and start consuming the PTY. Call right after spawn. */
export function createTerminal(sessionId: string): void {
  if (entries.has(sessionId)) return;

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: THEME
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  // xterm needs a laid-out parent to measure against, so open() happens on
  // attach(); until then the terminal buffers writes internally.

  const parser = createPtyParser(sessionId);

  const offData = window.api.onPtyData(sessionId, (data) => {
    term.write(data);
    parser.push(data);
  });

  const offExit = window.api.onPtyExit(sessionId, ({ exitCode }) => {
    parser.dispose();
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

  entries.set(sessionId, {
    id: sessionId,
    term,
    fit,
    webgl: null,
    host,
    parser,
    offData,
    offExit,
    resizeObserver: null
  });
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
  e.parser.dispose();
  e.term.dispose();
  entries.delete(sessionId);
}

export function hasTerminal(sessionId: string): boolean {
  return entries.has(sessionId);
}
