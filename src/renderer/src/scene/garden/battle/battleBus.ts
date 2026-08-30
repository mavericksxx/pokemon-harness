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
  /** A `Task` tool call started — spawn (or queue) one wild battler.
   *  `label` (parity sweep item 7) — the Task's own `description` (falling
   *  back to `subagent_type`), lifted straight off the PreToolUse payload at
   *  the instant this fires (hookRouter.ts's `toolTargetFromInput`) — NOT
   *  read back out of the store later, where it'd already be stale/
   *  overwritten by the session's next tool call. Undefined for the regex-
   *  fallback path (ptyParser.ts, no tool_input to read a description from)
   *  — SubagentRosterCard.tsx falls back to species-as-title for those. */
  | { type: 'spawn'; parentId: string; label?: string; toolUseId?: string }
  /** A tool call actually ran while a battle is active — one attack beat. */
  | { type: 'attack'; parentId: string; tool: string }
  /** A subagent-scoped PreToolUse observed on its parent's hook channel — a
   *  best-effort live-tool update for a roaming battler. */
  | { type: 'subTool'; parentId: string; subagentId: string; tool: string; toolTarget: string }
  /** One subagent finished — remove exactly one battler. `taskId` (battler ↔
   *  task-id correlation fix), when present, names the exact CLI-internal
   *  task-id that finished — `BattleManager.handleEnd` retires the battler
   *  stamped with it, falling back to the oldest-roaming heuristic only for a
   *  battler that never got stamped (see `handleCorrelate`/'correlate'
   *  below). */
  | { type: 'end'; parentId: string; taskId?: string }
  /** Regex-fallback heuristic only: the parent went idle/blocked with no clean
   *  per-subagent completion signal available — end the whole battle. */
  | { type: 'endAll'; parentId: string }
  /** The parent session's own turn fully ended (`Stop`, hooks path only) —
   *  proof every subagent it dispatched this turn is done ONLY for a
   *  SYNCHRONOUS `Task` dispatch (which blocks the parent's turn until it
   *  genuinely completes). hookRouter.ts gates this signal so it's only ever
   *  emitted when no async dispatch is known to still be outstanding for
   *  that parent — see its `Stop` case and taskNotificationWatcher.ts's
   *  header (Bug B fix, 2026-08-29) for why an unqualified Stop is NOT such
   *  proof for an async dispatch. See BattleManager.ts's file header and
   *  `handleParentDone` for why this replaces the old wall-clock completion
   *  fallback. */
  | { type: 'parentDone'; parentId: string }
  /** Battler ↔ task-id correlation (2026-08-29 fix, taskNotificationWatcher.ts
   *  `battle:taskCorrelated`): links a dispatch's `tool_use_id` (known at
   *  spawn — see the `spawn` signal above) to the CLI-internal task-id a
   *  later completion will name. `BattleManager.handleCorrelate` stamps the
   *  battler that dispatch spawned, or — if none carries that `tool_use_id`
   *  — treats it as a RESUME (the same task-id relaunched after its earlier
   *  battler fully faded) and re-materializes one from remembered species/
   *  label, guarding against a double-spawn if a stamped battler for that
   *  task-id is already live. */
  | { type: 'correlate'; parentId: string; toolUseId: string; taskId: string };

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
