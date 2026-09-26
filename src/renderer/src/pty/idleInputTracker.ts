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

/** Called from `term.onData` for every chunk of raw bytes the user typed. An
 *  Enter (`\r` or `\n`) anywhere in the chunk resets `hasBytesSinceEnter`
 *  for whatever follows it in the SAME chunk (xterm normally sends one key
 *  at a time, so a multi-char chunk is the exception, e.g. a paste) —
 *  conservatively, any Enter in the chunk clears the flag, and any
 *  non-Enter byte after it (or the whole chunk if there's no Enter) sets it
 *  again. */
export function noteTypedInput(sessionId: string, data: string): void {
  const s = states.get(sessionId) ?? { hasBytesSinceEnter: false, lastKeypressAt: 0 };
  s.lastKeypressAt = Date.now();
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
