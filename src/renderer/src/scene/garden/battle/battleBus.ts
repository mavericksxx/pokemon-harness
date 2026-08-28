/**
 * Subagent-battle signal bus (Phase 4 Part B).
 *
 * Detection lives wherever a session's activity is observed — the hooks
 * router (`pty/hookRouter.ts`, authoritative) and the regex parser fallback
 * (`pty/ptyParser.ts`, for non-claude CLIs or when hooks go quiet) — neither
 * of which knows about Pixi or the garden scene. `BattleManager` (which does)
 * is instantiated inside GardenScene's effect. This tiny synchronous emitter
 * is the seam between the two: whichever side notices a Task spawn/attack/end
 * calls `emitBattleSignal`, and GardenScene's BattleManager is the only
 * subscriber that matters at runtime.
 */
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { bumpCounter } from '@/diagnosticsCounters';

export type BattleSignal =
  /** A `Task` tool call started — spawn (or queue) one wild battler. */
  | { type: 'spawn'; parentId: string }
  /** A tool call actually ran while a battle is active — one attack beat. */
  | { type: 'attack'; parentId: string; tool: string }
  /** One subagent finished (`SubagentStop`) — remove exactly one battler. */
  | { type: 'end'; parentId: string }
  /** Regex-fallback heuristic only: the parent went idle/blocked with no clean
   *  per-subagent completion signal available — end the whole battle. */
  | { type: 'endAll'; parentId: string }
  /** The parent session's own turn fully ended (`Stop`, hooks path only) —
   *  a deterministic proof every subagent it dispatched this turn is done,
   *  since a `Task` tool call blocks the parent's turn until it genuinely
   *  completes. See BattleManager.ts's file header and `handleParentDone`
   *  for why this replaces the old wall-clock completion fallback. */
  | { type: 'parentDone'; parentId: string };

type Listener = (signal: BattleSignal) => void;

const listeners = new Set<Listener>();

export function emitBattleSignal(signal: BattleSignal): void {
  // Each listener isolated in its own try/catch so one bad listener (e.g.
  // BattleManager.onSignal/handleSpawn throwing) can't starve the others —
  // see the forensic writeup on v1.1.0's disappearing subagent-battle spawns.
  for (const l of listeners) {
    try {
      l(signal);
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('battle-bus', 'error', 'battle signal listener threw', {
        signalType: signal.type,
        parentId: signal.parentId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }
  }
}

export function onBattleSignal(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
