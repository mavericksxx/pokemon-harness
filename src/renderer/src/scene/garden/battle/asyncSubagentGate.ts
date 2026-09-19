/**
 * Async-subagent gate — the `pendingAsyncLaunches` counter hookRouter.ts
 * writes and BattleManager.ts reads, kept in its own IPC-free module so
 * BattleManager can be loaded without hookRouter's module-scope
 * `window.api.on*` registrations (e.g. by the landing-site showreel).
 * Moved verbatim out of hookRouter.ts; hookRouter still owns every write.
 */

/** Bug B fix (2026-08-29) — count of async `Task`/`Agent` dispatches this
 *  session has launched (per taskNotificationWatcher.ts's `toolUseResult.
 *  isAsync` detection) that haven't yet been terminally notified. Gates the
 *  `Stop` case below: `Stop` only counts as subagent-completion proof when
 *  this is 0 for that session — see taskNotificationWatcher.ts's header for
 *  the full evidence this is built on. Registered once, at module load,
 *  mirroring `onDelegateHookEvent`'s single-global-listener pattern
 *  (preload/index.ts) — every parent session's events funnel through the
 *  same two channels, so there's no natural per-session subscribe/unsubscribe
 *  point the way `onHookEvent`/`onCostUpdate` have (terminalRegistry.ts). */
export const pendingAsyncLaunches = new Map<string, number>();

/** True while `parentId` has at least one async dispatch launched (per the
 *  transcript watcher) that hasn't yet been terminally notified. Exported so
 *  BattleManager.ts can re-check it at the ONE OTHER site that can queue a
 *  roaming sub off a Stop-derived signal — `updateOneBattle`'s
 *  `queueEligibleAt` firing, for a sub that was too young to queue
 *  immediately when `Stop` first arrived (see `handleParentDone` below).
 *  Without that second check, the very race this fix exists to close still
 *  gets through: `pendingAsyncLaunches` is fed by a POLLED transcript watch
 *  (~2s), so the Stop that fires ~200ms after an async dispatch's PostToolUse
 *  can land before the poller has ever seen the launch line — the gate here
 *  reads 0, `Stop` passes through, and `queueEligibleAt` (armed for
 *  `MIN_ROAM_MS` later) fires UNCONDITIONALLY unless that later check ALSO
 *  consults this same counter. By the time `MIN_ROAM_MS` (15s) has elapsed,
 *  the poller has had many chances to see the launch line, so this correctly
 *  reads outstanding by then for a real async dispatch. */
export function hasPendingAsyncSubagents(parentId: string): boolean {
  return (pendingAsyncLaunches.get(parentId) ?? 0) > 0;
}
