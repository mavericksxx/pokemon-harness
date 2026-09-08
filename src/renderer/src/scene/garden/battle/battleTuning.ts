/**
 * Tuning constants for the battle subsystem — pure move, extracted verbatim
 * from BattleManager.ts (no behavior change). See that file's own header for
 * the full subagent-battle design writeup these constants tune.
 */
export const LUNGE_MS = 300;
export const HOLD_MS = 280;
export const RETURN_MS = 320;
export const ATTACK_TOTAL_MS = LUNGE_MS + HOLD_MS + RETURN_MS;
/** Lunge travels this fraction of the full gap toward the opponent and back
 *  — always well short of contact, whatever the gap or sprite size (see
 *  gapTilesForBatch). */
export const LUNGE_FRACTION = 0.28;
export const SHAKE_MS = 320;
export const FACEOFF_MS = 550;
export const ENDING_MS = 550;
/** Exactly one challenger per battle now (spec: "strictly one battle at a
 *  time" — a completion battle is one subagent vs. the parent, never a
 *  batch). Kept as a named constant, not inlined as 1, because the ring/
 *  arc-slot machinery below (pickChallengerStandTileFor's 3-way arc,
 *  gapTilesForBatch) still takes an array + slot index — MAX_RING=1
 *  exercises exactly slot 0 of that existing machinery rather than
 *  deleting code that already generalizes fine. */
export const MAX_RING = 1;
/** Scripted attack exchanges per skirmish before it concludes on its own —
 *  the only thing that CAN conclude it now that real per-subagent signals
 *  can't be trusted for the moment-to-moment beat (see file header). Was 2
 *  attacks at a snappier 480ms each, which read as "just one attack each" —
 *  the whole exchange needs 8-10s to read as a real fight rather than a
 *  blip. Getting there is deliberately a combination of more hits AND
 *  somewhat slower hits, not either alone: 8 attacks at the original 480ms
 *  pace would be a rapid-fire blur, and 2 attacks stretched to fill the same
 *  time would be a slow-motion crawl. So WAVE_ATTACKS goes to 8 (4x) while
 *  LUNGE_MS/HOLD_MS/RETURN_MS each roughly double (150/150/180 ->
 *  300/280/320, ATTACK_TOTAL_MS 480 -> 900) — proportional, not flat, so the
 *  lunge/hold/return motion in applyPositions still reads the same shape,
 *  just unhurried. Total: FACEOFF_MS + WAVE_ATTACKS * ATTACK_TOTAL_MS +
 *  ENDING_MS = 550 + 8*900 + 550 = 8300ms, inside the 8-10s target. */
export const WAVE_ATTACKS = 8;
/** Combo-coalescing pin fix (2026-09-08): `handleAttack` restarts the
 *  current beat's timeline (elapsedMs/hitApplied) when a rapid tool event
 *  arrives before the hit has landed, so a fast burst of calls still reads
 *  as one coalesced combo instead of a queued replay per event (see
 *  handleAttack's own comment). Without a cap, a subagent calling faster
 *  than ATTACK_TOTAL_MS apart could restart that same beat indefinitely —
 *  waveAttacks would never increment, and the wave would only ever end via
 *  WAVE_HARD_CAP_MS's force-conclude, which skips beginEnding's victory
 *  pose. This caps how many times ONE beat may restart before it's just
 *  left to finish on its own clock. */
export const MAX_COMBO_RESTARTS = 3;

/** Minimum face-off gap, in tiles, between the parent and a battler — chosen
 *  so two average-sized sprites (2-2.5 drawn tiles tall) read as clearly
 *  separated rather than overlapping. Bumped up when either side's drawn
 *  height crosses LARGE_TILE_THRESHOLD (a Snorlax/Tyranitar-class sprite). */
export const GAP_BASE_TILES = 3;
export const GAP_LARGE_BONUS_TILES = 2;
export const LARGE_TILE_THRESHOLD = 2.7;

// Roam pacing — mirrors Walker.ts's own idle wander timing/range exactly, so
// a roaming subagent reads the same as any other idling walker in the garden
// (spec: "simply roams the garden like other pokemon").
export const WANDER_MIN_DELAY = 1.5;
export const WANDER_MAX_DELAY = 4.5;
export const WANDER_RANGE = 5;
/** Roaming task labels are deliberately occasional rather than pinned over
 *  every working battler. Each battler gets its own deterministic cycle and
 *  initial phase, so a group reads as organic instead of blinking together. */
export const ROAM_LABEL_VISIBLE_MS = 3_000;
export const ROAM_LABEL_CYCLE_MIN_MS = 7_000;
export const ROAM_LABEL_CYCLE_MAX_MS = 10_000;
/** How far in from the map edge a roam "home" corner sits — enough that a
 *  roaming subagent's own local jitter (WANDER_RANGE) never walks it off the
 *  map or into an unwalkable border. */
export const CORNER_MARGIN = 3;

/** A subagent must roam for at least this long before a `parentDone` signal
 *  (the parent's own `Stop` hook — see `handleParentDone`) is allowed to
 *  queue its completion battle. Guards the degenerate case of a `Task`
 *  dispatched and the parent's turn ending in the same beat — without this
 *  floor that would read as a pokemon appearing and instantly dying, exactly
 *  the premature-death complaint this rework exists to fix. A genuine
 *  `SubagentStop` (`handleEnd`) bypasses it: that signal names the ONE
 *  subagent that actually just finished, not a coarse "the parent's whole
 *  turn ended" proxy, so there's nothing to guard against. */
export const MIN_ROAM_MS = 15_000;

/** Absolute cap on how long a battler may sit `roaming` before it queues for
 *  its completion battle unconditionally, ignoring `hasPendingAsyncSubagents`
 *  entirely — the backstop for two failure modes that neither `MIN_ROAM_MS`/
 *  `queueEligibleAt` nor `handleEnd`/`handleParentDone` can ever close on
 *  their own: (1) a subagent that dies without ANY terminal notification
 *  (e.g. killed by an API error) never decrements `pendingAsyncLaunches`, so
 *  `hasPendingAsyncSubagents` reads true for that parent forever and the
 *  `queueEligibleAt` re-check below never passes — the battler ↔ task-id
 *  correlation fix (below) doesn't touch this case at all, since there's no
 *  completion to correlate; (2) a RESUMED agent's second completion
 *  notification USED TO BE deduped by task-id (taskNotificationWatcher.ts's
 *  `t.notified`) and silently swallowed — now fixed at the source (that
 *  watcher un-guards a task-id from `notified` the moment it sees the same
 *  id dispatch async again, and `handleCorrelate` re-materializes the
 *  battler from `retiredTaskInfo`'s remembered species/label) — but only for
 *  as long as this manager's own in-memory `retiredTaskInfo` still holds that
 *  task-id (an app restart between the original completion and the resume
 *  loses it, same as every other purely in-memory piece of battle state).
 *  Either way the sub would otherwise sit in 'roaming' forever — a card on
 *  the roster strip for an agent that's long gone (log-confirmed:
 *  `subagentsMaterialized` staying permanently ahead of
 *  `subagentsCleanedUp`). Real agents in this project routinely run 9-16
 *  minutes and have hit ~26 in the extreme; set generously past that
 *  extreme (not just "around" it) — a premature farewell battle for a
 *  still-running agent is worse than a late one for a dead agent, and a
 *  cap equal to or only slightly above the observed extreme would risk
 *  firing on that exact legitimate case.
 *
 *  Real per-subagent identity now exists (`handleCorrelate`, fed by
 *  taskNotificationWatcher.ts's `battle:taskCorrelated` — a dispatch's
 *  `tool_use_id`, known at PreToolUse, linked to the CLI-internal task-id a
 *  completion names), so `handleEnd` resolves a completion to the sub that
 *  actually finished instead of "the oldest roaming one" whenever that
 *  correlation landed. This cap remains the backstop for whatever it still
 *  can't close — failure mode (1) above, or any battler whose correlation
 *  never arrived at all — not a replacement for it. */
export const MAX_ROAM_MS = 30 * 60_000;

/** Cap on `retiredTaskInfo`'s size (2026-09-08 fix — see that field's own
 *  comment): a generously large bound, well past how many subagents even a
 *  very long-running or heavily-resumed session would realistically
 *  complete, so eviction is a genuine backstop rather than something that
 *  routinely trims real resume memory. */
export const RETIRED_TASK_INFO_CAP = 500;

/** Gap enforced, in ms, between the end of one completion battle and the
 *  start of the next — GLOBALLY, across every parent (the queue in
 *  `pickNextQueued`/`nextBattleEarliestAt` is what makes the lock global,
 *  not per-parent). Spec: "a few seconds of free time" so battles never
 *  overlap or instantly chain. */
export const BATTLE_COOLDOWN_MIN_MS = 4_000;
export const BATTLE_COOLDOWN_MAX_MS = 6_000;

/** Absolute outer bound on a single wave, whatever phase it's in — the
 *  self-healing backstop if a bug (or a corrupted battler) ever wedges a
 *  wave partway through, so a stuck battle can never block the global queue
 *  forever (see file header's invisible-subagent writeup). A normal wave
 *  (alert + a walk-in + FACEOFF_MS + WAVE_ATTACKS attacks + ENDING_MS) now
 *  totals roughly 8-9 seconds for the scripted exchange alone, plus whatever
 *  the alert and walk-in add on top; this is deliberately generous so it
 *  never trips a legitimately long approach walk, only a genuinely stuck one. */
export const WAVE_HARD_CAP_MS = 60_000;
/** Floor under the per-wave, distance-based watchdog computed in
 *  `admitBattle` for the `alert`/`approaching` phases specifically — the
 *  only two phases bounded by something actually happening in the world (a
 *  poof finishing, a goTo() arriving) rather than a fixed clock. A roaming
 *  challenger can be anywhere on the map now (not held near the parent like
 *  the old design's fixed-radius spawn), so a flat cap alone would misfire
 *  on a genuinely long walk; this is just the minimum for a short one. */
export const WAVE_STUCK_MIN_MS = 15_000;
/** Mirrors Battler.ts's own (unexported) `SPEED` — duplicated here only for
 *  the stuck-watchdog's walk-time estimate in `admitBattle`. Not imported
 *  because Battler.ts doesn't export it; if that ever changes, bump this
 *  too. */
export const BATTLER_SPEED_PX_S = 44;
