/**
 * Advisor-consult signal bus (advisor-pokemon feature) — kept deliberately
 * separate from battleBus.ts's ordinary subagent-battle signals, not an
 * extension of it: an advisor consult (`Task` with `subagent_type ===
 * 'advisor'`) never roams, queues, or battles — it's a hovering companion
 * beside its parent for the consult's duration, a much simpler lifecycle
 * than `BattleManager`'s (see that file's own header and AdvisorManager.ts,
 * this bus's sole subscriber).
 *
 * Same seam battleBus.ts describes: hookRouter.ts is the detector (never
 * touches Pixi), AdvisorManager (instantiated inside GardenScene's effect,
 * same as BattleManager) is the one subscriber that matters at runtime.
 *
 * Mutual exclusivity with battleBus.ts's own 'spawn' lives in hookRouter.ts,
 * not here: an advisor dispatch emits ONLY here, an ordinary dispatch emits
 * ONLY there. `correlate`/`end`, though, are forwarded into BOTH buses
 * unconditionally by hookRouter.ts (belt-and-braces — see its own comment)
 * since the CLI-internal task-id a completion names doesn't say in advance
 * which bus's battler/companion it belongs to; AdvisorManager silently
 * no-ops for a `toolUseId`/`taskId` it doesn't recognize, same tolerance
 * BattleManager already has for a stale signal.
 */
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { bumpCounter } from '@/diagnosticsCounters';

export type AdvisorSignal =
  /** An advisor `Task` dispatch started — spawn one hovering companion
   *  beside `parentId`'s own walker. `toolUseId` (when present) is this
   *  exact dispatch's `tool_use_id`, the one identity available at spawn
   *  time — same role as battleBus.ts's `spawn` signal's own `toolUseId`. */
  | { type: 'spawn'; parentId: string; toolUseId?: string }
  /** Links a dispatch's `tool_use_id` (known at spawn) to the CLI-internal
   *  task-id a later completion will name — same fix, scaled down, as
   *  battleBus.ts's `correlate` (see BattleManager.handleCorrelate for the
   *  pattern this mirrors). */
  | { type: 'correlate'; parentId: string; toolUseId: string; taskId: string }
  /** The advisor consult finished — despawn its companion. `taskId`, when
   *  present, names the exact CLI-internal task-id that finished, so a
   *  parent running more than one consult at once retires the right one. */
  | { type: 'end'; parentId: string; taskId?: string };

type Listener = (signal: AdvisorSignal) => void;

const listeners = new Set<Listener>();

export function emitAdvisorSignal(signal: AdvisorSignal): void {
  // Each listener isolated in its own try/catch, same reasoning as
  // battleBus.ts's emitBattleSignal — one bad listener must never starve
  // the others.
  for (const l of listeners) {
    try {
      l(signal);
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('advisor-bus', 'error', 'advisor signal listener threw', {
        signalType: signal.type,
        parentId: signal.parentId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }
  }
}

export function onAdvisorSignal(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
