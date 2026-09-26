/**
 * External sessions plan §7 step 5 — "ours" half of the auto-reload idle
 * gate: has this session's terminal had anything typed into it since the
 * last Enter, and how long ago was the last keypress. `terminalRegistry.ts`'s
 * `term.onData` is the one place raw pty input leaves the renderer, so it's
 * the only call site that needs to feed this.
 */

interface InputState {
  /** True from the first byte after the last Enter until the next Enter. */
  hasBytesSinceEnter: boolean;
  lastKeypressAt: number;
}

const states = new Map<string, InputState>();

/** How long a session must have gone without a keypress before the "ours"
 *  idle gate considers it settled — external sessions plan §7's "no
 *  keypress in the last 10s". */
const IDLE_KEYPRESS_MS = 10_000;

/** Re-review item 3 — the ONLY onData chunks treated as "not literally
 *  typed by the user" (xterm auto-replies fed back through this same
 *  `onData` path, not real input): an OSC string (colour-query responses
 *  from `\x1b]10;?\x07`/`\x1b]11;?\x07`), a focus in/out DECSET 1004 report
 *  (`\x1b[I`/`\x1b[O`), or a Device Attributes / cursor-position reply
 *  (`\x1b[?…c`, `\x1b[…R`). D14's original fix over-matched EVERY
 *  ESC-prefixed chunk, which also silently swallowed a real bracketed
 *  paste (`\x1b[200~…\x1b[201~`, always ESC-prefixed) as "not a draft" —
 *  auto-reload could then discard a just-pasted draft. Deliberately does
 *  NOT match arrow/function/paste sequences: those go through the ordinary
 *  Enter-scan below like any other input, which is the safe direction to
 *  err in (worst case, a reload waits a little longer than strictly
 *  necessary; it never discards something typed). */
const SYNTHETIC_REPLY_RE = /^\x1b(?:\][^\x07]*\x07?|\[[IO]|\[\?[0-9;]*c|\[[0-9;]*R)$/;

/** Called from `term.onData` for every chunk of raw bytes leaving the
 *  terminal (real keystrokes, a paste, or one of xterm's own synthetic
 *  auto-replies — see `SYNTHETIC_REPLY_RE`). An Enter (`\r` or `\n`)
 *  anywhere in the chunk resets `hasBytesSinceEnter` for whatever follows
 *  it in the SAME chunk (a paste is the one case a chunk carries more than
 *  one logical "line" at once — the bracketed-paste markers themselves
 *  contain no `\r`/`\n`, so this naturally treats a paste's own internal
 *  newlines as this same "reset, then whatever's after is the new draft"
 *  logic, and the paste's closing marker as part of that final segment). */
export function noteTypedInput(sessionId: string, data: string): void {
  const s = states.get(sessionId) ?? { hasBytesSinceEnter: false, lastKeypressAt: 0 };
  // Any chunk counts as recent activity, including a synthetic reply and a
  // real arrow key — both keep the 10s "just active" window alive.
  s.lastKeypressAt = Date.now();
  if (SYNTHETIC_REPLY_RE.test(data)) {
    states.set(sessionId, s);
    return;
  }
  const lastEnterIdx = Math.max(data.lastIndexOf('\r'), data.lastIndexOf('\n'));
  const remainder = lastEnterIdx >= 0 ? data.slice(lastEnterIdx + 1) : data;
  s.hasBytesSinceEnter = remainder.length > 0;
  states.set(sessionId, s);
}

/** Whether the "ours" idle gate is open for `sessionId`: nothing typed since
 *  the last Enter, and no keypress at all in the last `IDLE_KEYPRESS_MS`. A
 *  session that has never had anything typed into it (no entry yet) counts
 *  as idle — there is no draft to protect. */
export function isInputIdle(sessionId: string): boolean {
  const s = states.get(sessionId);
  if (!s) return true;
  if (s.hasBytesSinceEnter) return false;
  return Date.now() - s.lastKeypressAt >= IDLE_KEYPRESS_MS;
}

/** Cleanup hook for a disposed/despawned session — avoids leaking an entry
 *  per session id forever. */
export function clearInputState(sessionId: string): void {
  states.delete(sessionId);
}
