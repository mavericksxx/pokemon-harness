/**
 * External sessions plan §7 step 5 — renderer half of the outside-write
 * detector. Main's `outsideWriteDetector.ts` only ever emits a candidate
 * (`outsideWrite:candidate`, one per session id); this module owns the
 * idle gate ("ours": hook status, `awaitingSubagentIdle`, typed bytes,
 * keypress recency), the manual chip's visible state, and the auto-reload
 * circuit breaker (at most one auto-reload per session per
 * `CIRCUIT_BREAKER_MS`).
 *
 * Scoped strictly to `continuedFrom` sessions by construction — main never
 * registers/emits for a native session (`OutsideWriteDetector.
 * onSessionsChecked`), so nothing here needs its own extra check for that.
 */
import { useStore } from '@/store/store';
import { isAwaitingSubagentIdle } from '@/pty/hookRouter';
import { isInputIdle } from '@/pty/idleInputTracker';
import { reloadSession } from '@/sessionReload';
import { safeLogDiagnostic } from '@/diagnosticsClient';

/** Plan §7's "at most one auto-reload per N minutes per session." */
const CIRCUIT_BREAKER_MS = 3 * 60_000;

/** How often a pending (gate-closed) candidate is re-checked for the gate
 *  having opened since — the chip disappears and a reload fires the moment
 *  it does, without the user having to click anything. */
const RECHECK_MS = 2_000;

const pending = new Set<string>();
const lastAutoReloadAt = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to changes in which sessions currently show the "Updated
 *  elsewhere — reload" chip. Returns an unsubscribe function — mirrors the
 *  shape every other renderer pub-sub in this app uses (window.api.on*). */
export function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPending(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** "Ours" half of the idle gate — plan §7's "status idle (not blocked/
 *  working/napping), not `awaitingSubagentIdle`, no bytes typed into the
 *  pty since the last Enter, no keypress in the last 10s." */
function ourGateOpen(sessionId: string): boolean {
  const s = useStore.getState().sessions.find((x) => x.id === sessionId);
  if (!s) return false;
  if (s.status !== 'idle' || s.napping) return false;
  if (isAwaitingSubagentIdle(sessionId)) return false;
  return isInputIdle(sessionId);
}

function breakerAllows(sessionId: string): boolean {
  const last = lastAutoReloadAt.get(sessionId);
  return last === undefined || Date.now() - last >= CIRCUIT_BREAKER_MS;
}

async function attemptReload(sessionId: string, why: 'immediate' | 'gate-opened'): Promise<void> {
  if (!breakerAllows(sessionId)) {
    safeLogDiagnostic('outside-write-gate', 'info', 'auto-reload suppressed by circuit breaker', {
      sessionId,
      why
    });
    // Still pending — the chip stays up; the breaker will allow the next
    // periodic recheck once its own window has passed.
    return;
  }
  lastAutoReloadAt.set(sessionId, Date.now());
  pending.delete(sessionId);
  notify();
  safeLogDiagnostic('outside-write-gate', 'info', 'auto-reload firing', { sessionId, why });
  const ok = await reloadSession(sessionId);
  if (!ok) {
    // Reload itself refused/failed (old process didn't exit, no id to
    // resume) — the session is untouched; re-show the chip so the user has
    // a manual path instead of this silently going nowhere.
    pending.add(sessionId);
    notify();
  }
}

/** Called with every `outsideWrite:candidate` — immediately reloads if the
 *  gate is already open (breaker permitting), otherwise shows the chip and
 *  leaves a recheck timer running so the gate opening later still
 *  auto-reloads without another candidate event needing to arrive. */
function onCandidate(sessionId: string): void {
  if (ourGateOpen(sessionId)) {
    void attemptReload(sessionId, 'immediate');
    return;
  }
  if (!pending.has(sessionId)) {
    pending.add(sessionId);
    notify();
    safeLogDiagnostic('outside-write-gate', 'info', 'candidate — gate closed, showing chip', { sessionId });
  }
}

let recheckTimer: ReturnType<typeof setInterval> | null = null;

function recheckPending(): void {
  for (const sessionId of [...pending]) {
    if (ourGateOpen(sessionId)) void attemptReload(sessionId, 'gate-opened');
  }
}

/** Wires the main-process candidate channel and starts the periodic
 *  gate-opened recheck. Call once at boot, same pattern as sessions.ts's
 *  other `start*Listener` functions. */
export function startOutsideWriteGate(): void {
  window.api.onOutsideWriteCandidate(onCandidate);
  if (!recheckTimer) recheckTimer = setInterval(recheckPending, RECHECK_MS);
}

/** Manual chip action (AgentRosterCard.tsx) — bypasses the idle gate and the
 *  circuit breaker entirely: an explicit user click is never something this
 *  gate should second-guess. Does NOT count against the breaker, so an
 *  auto-reload can still fire again on its own schedule afterward if a
 *  further outside write shows up. */
export async function manualReload(sessionId: string): Promise<boolean> {
  pending.delete(sessionId);
  notify();
  const ok = await reloadSession(sessionId);
  if (!ok) {
    pending.add(sessionId);
    notify();
  }
  return ok;
}
