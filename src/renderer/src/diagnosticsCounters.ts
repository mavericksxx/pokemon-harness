/**
 * Local-only invariant counters (BACKLOG item 1 #3) — a handful of
 * started/resolved pairs that should stay roughly in balance, incremented at
 * the obvious call sites (pty/hookRouter.ts, scene/garden/battle/
 * BattleManager.ts). No framework: one plain object, one setInterval.
 * Snapshotted to the diagnostics log every SNAPSHOT_INTERVAL_MS and once
 * more on quit (best-effort — see `startCounterReporting`'s `beforeunload`
 * listener, which is not a guaranteed flush).
 *
 * `hookEventsReceived`/`Routed`/`Dropped` are renderer-scoped: they count
 * only what reaches pty/hookRouter.ts's `handleHookEvent`, i.e. events
 * hookBridge.ts (main) already decided belong to a live, known-event hook
 * payload. Main-side drops (no `harness_agent_id`, an unrecognized event
 * name) never reach the renderer at all and are deliberately not counted
 * here — main.js's own diagnostics log covers those separately (see the
 * malformed-payload log in hookBridge.ts).
 */
import { WANDER_SAFETY_MS } from '@/scene/garden/battle/BattleManager';
import { safeLogDiagnostic } from '@/diagnosticsClient';

export interface Counters {
  battlesStarted: number;
  battlesResolved: number;
  hookEventsReceived: number;
  hookEventsRouted: number;
  hookEventsDropped: number;
  subagentsSpawned: number;
  subagentsMaterialized: number;
  subagentsCleanedUp: number;
}

const counters: Counters = {
  battlesStarted: 0,
  battlesResolved: 0,
  hookEventsReceived: 0,
  hookEventsRouted: 0,
  hookEventsDropped: 0,
  subagentsSpawned: 0,
  subagentsMaterialized: 0,
  subagentsCleanedUp: 0
};

export function bumpCounter(key: keyof Counters): void {
  counters[key]++;
}

export function counterSnapshot(): Counters {
  return { ...counters };
}

const SNAPSHOT_INTERVAL_MS = 60_000;
/** A wave (battle skirmish) is bounded by a fixed clock or WAVE_STUCK_MS
 *  (15s) at the outside — 5 minutes of `battlesStarted` ahead of
 *  `battlesResolved` is a genuinely stuck wave, not normal operation. */
const BATTLE_DIVERGENCE_MS = 5 * 60 * 1000;
/** `subagentsSpawned` vs `subagentsMaterialized` should reconcile within the
 *  same synchronous call (battleBus.ts's emitter is synchronous) — a lasting
 *  gap means BattleManager's `!rt`/`!species` guard is dropping spawns. */
const SPAWN_MATERIALIZE_DIVERGENCE_MS = 5 * 60 * 1000;
/** `subagentsMaterialized` vs `subagentsCleanedUp`: a subagent legitimately
 *  sits mid-lifecycle for up to WANDER_SAFETY_MS (8min) before its final
 *  skirmish even starts — the threshold has to clear that plus room for the
 *  final skirmish itself, or every real subagent trips this. */
const SUBAGENT_LIFECYCLE_DIVERGENCE_MS = WANDER_SAFETY_MS + 2 * 60_000;

interface DivergingPair {
  label: string;
  a: keyof Counters;
  b: keyof Counters;
  thresholdMs: number;
  since: number | null;
  warned: boolean;
}

const pairs: DivergingPair[] = [
  { label: 'battles', a: 'battlesStarted', b: 'battlesResolved', thresholdMs: BATTLE_DIVERGENCE_MS, since: null, warned: false },
  {
    label: 'subagent spawn->materialize',
    a: 'subagentsSpawned',
    b: 'subagentsMaterialized',
    thresholdMs: SPAWN_MATERIALIZE_DIVERGENCE_MS,
    since: null,
    warned: false
  },
  {
    label: 'subagent lifecycle',
    a: 'subagentsMaterialized',
    b: 'subagentsCleanedUp',
    thresholdMs: SUBAGENT_LIFECYCLE_DIVERGENCE_MS,
    since: null,
    warned: false
  }
];

function checkDivergence(): void {
  const now = Date.now();
  for (const pair of pairs) {
    const diverged = counters[pair.a] > counters[pair.b];
    if (!diverged) {
      pair.since = null;
      pair.warned = false;
      continue;
    }
    if (pair.since === null) pair.since = now;
    if (!pair.warned && now - pair.since >= pair.thresholdMs) {
      pair.warned = true;
      safeLogDiagnostic('counters', 'warn', `${pair.label} counter diverging`, {
        [pair.a]: counters[pair.a],
        [pair.b]: counters[pair.b],
        sinceMs: now - pair.since
      });
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Idempotent — call once at renderer boot (main.tsx). Starts the periodic
 *  snapshot/divergence-check loop and a best-effort quit-time flush. */
export function startCounterReporting(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkDivergence();
    safeLogDiagnostic('counters', 'info', 'snapshot', counterSnapshot());
  }, SNAPSHOT_INTERVAL_MS);
  // Best-effort only: `beforeunload` fires for an ordinary window close/quit,
  // but nothing here can guarantee the async IPC round-trip actually
  // completes before the renderer's JS context is torn down.
  window.addEventListener('beforeunload', () => {
    checkDivergence();
    safeLogDiagnostic('counters', 'info', 'snapshot (quit flush)', counterSnapshot());
  });
}
