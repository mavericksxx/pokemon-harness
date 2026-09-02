/**
 * Subagent battles — one wild Pokemon per spawned `Task` subagent, fought out
 * beside the parent session's own walker.
 *
 * ── Lifecycle (Phase A redesign, 2026-08-29 — supersedes the earlier
 * intro-skirmish -> wander -> final-skirmish flow) ──────────────────────────
 *
 *   roaming -> queued -> battling -> leaving -> gone
 *
 * On spawn (a `Task` PreToolUse) a battler pops into existence and just
 * ROAMS the garden — no intro battle, no ring formation, indistinguishable
 * from any other idling walker (see `pickRoamHome`/`updateRoaming`, which
 * mirror Walker.ts's own wander exactly). It stays that way for as long as
 * the real subagent's work takes. When it's done, it's `queued`; once the
 * GLOBAL queue (below) admits it, it walks up to the parent for ONE
 * skirmish (`battling`) — same alert/approach/faceoff/attack choreography
 * this feature has always used — loses, then poofs away for good
 * (`leaving` -> `gone`). This one completion battle is the entire lifecycle;
 * there is no re-entry to roaming.
 *
 * GLOBAL QUEUE, ONE BATTLE AT A TIME, EVERYWHERE. Multiple subagents
 * finishing close together (parallel waves — common) must not fight
 * simultaneously or chain back-to-back, and that holds ACROSS parent
 * sessions too, not just within one: at most one `ParentBattle` in
 * `this.battles` may have `wave !== 'idle'` at once, and a cooldown gap
 * (`BATTLE_COOLDOWN_MIN_MS`..`BATTLE_COOLDOWN_MAX_MS`) is enforced after
 * every conclusion before the next may start (see `update`,
 * `pickNextQueued`, `admitBattle`). The lock is DERIVED from `this.battles`
 * every tick rather than tracked as separate mutable state — a stray or
 * abandoned `ParentBattle` can desync tracked lock state from reality and
 * deadlock the queue forever; a derived lock can't, by construction.
 *
 * PREMATURE DEATH (v1.2.0 bug) was originally "fixed" by assuming a `Task`
 * tool call blocks the parent's own turn until it genuinely completes, so
 * the parent's `Stop` hook firing would be a deterministic proof every
 * subagent dispatched that turn was actually done (`handleParentDone`,
 * gated only by `MIN_ROAM_MS` below). That assumption is FALSE for an
 * ASYNC dispatch — confirmed live (2026-08-29, two independent `claude`
 * spawns captured via this app's own production HookBridge — see
 * taskNotificationWatcher.ts's header for the full evidence): PostToolUse
 * for an `Agent`/`Task` call fires within ~100-200ms and tells us NOTHING
 * about real completion, and no live evidence a SYNCHRONOUS Agent/Task
 * dispatch exists at all in the installed CLI — every real capture came
 * back `toolUseResult.isAsync: true`. Trusting Stop unconditionally
 * REINTRODUCED v1.2.0's exact bug under a different name: a battler's
 * completion battle firing while its real subagent kept working for many
 * more minutes (harness.log, 2026-08-28T23:37:20Z — the parent's `Stop`
 * fired ~100s after spawn; the dispatched subagent kept working for ~10
 * more minutes).
 *
 * Bug B fix (2026-08-29): `Stop` is no longer trusted unconditionally.
 * hookRouter.ts now tracks, per parent session, a count of async dispatches
 * launched (per the parent's own transcript — `toolUseResult.isAsync`, via
 * taskNotificationWatcher.ts) that haven't yet been terminally notified, and
 * only forwards `Stop` into the `'parentDone'` signal below when that count
 * is zero — i.e. `Stop` is proof of completion ONLY for whatever a
 * synchronous dispatch would be, and this app has never observed one to
 * exist. `MIN_ROAM_MS`/`queueEligibleAt` are KEPT (for that hypothetical
 * synchronous case, and because a genuinely synchronous dispatch's `Stop`
 * still can't fire before it's actually done, so the floor's original
 * "dispatched and Stop in the same beat" guard still holds), but
 * `updateOneBattle`'s `queueEligibleAt` firing site now ALSO re-checks the
 * same async count (`hasPendingAsyncSubagents`) rather than firing
 * unconditionally once the floor elapses — that counter is fed by a POLLED
 * transcript watch (~2s), so the FIRST `Stop` (which can fire ~200ms after
 * an async dispatch, before the poller has ever seen the launch line) can
 * read 0 and pass the check in `handleParentDone` even for a real async
 * dispatch; without the second check at the `queueEligibleAt` site, that
 * sub's deferred queuing (MIN_ROAM_MS later) would fire unconditionally and
 * reproduce the exact 2026-08-28 race this fix exists to close. By
 * MIN_ROAM_MS (15s) later the poller has had many chances to catch up, so
 * that second check correctly reads outstanding for a real async dispatch —
 * the actual completion signal for the async case that's the documented
 * common path today is `handleEnd`, fed by `onSubagentTaskNotification`
 * (hookRouter.ts), reading the parent's own
 * transcript for the CLI's `<task-notification>` injection.
 *
 * Real per-subagent hook signals, re-examined: verified live (see above)
 * that `SubagentStop` DOES fire for an async dispatch — contradicting this
 * file's own prior claim here that it "effectively never" does — but its
 * `harness_agent_id` tagging is NOT reliable (one capture tagged it with the
 * parent's own harness id, the other with the CLI's internal subagent id
 * instead, which silently routes to nobody — see hookBridge.ts). A real
 * `UserPromptSubmit` ALSO fires for the CLI's injected task-notification
 * turn — also contradicting this file's prior claim neither ever arrives.
 * Rather than build on either hook event directly, `onSubagentTaskNotification`
 * reads the parent's TRANSCRIPT instead (reliably tagged, since it's
 * registered per this app's own harness agentId) and is now the sole
 * trigger for `handleEnd`. `SubagentStop` (`handleEnd`'s other caller,
 * hookRouter.ts) is still wired but no longer forwards into a battle signal,
 * specifically to avoid double-firing 'end' for one real completion (which
 * would prematurely conclude an unrelated, still-working sibling). This
 * still matches publicly tracked upstream issues (e.g. anthropics/claude-code
 * #25147, #27755, #33049 — background/subagent completion signals
 * unreliable) in spirit: real, but not safe to build load-bearing
 * per-subagent identity on BY ITSELF.
 *
 * BATTLER ↔ TASK-ID CORRELATION (2026-08-29 fix, supersedes "queue the
 * oldest roaming sub" as `handleEnd`'s primary path): the missing identity
 * turned out not to need either unreliable hook — Claude Code's documented
 * `tool_use_id` (present on both PreToolUse and PostToolUse; see
 * shared/hookEvents.ts's `HookPayload.tool_use_id`) is the standard
 * Anthropic tool_use/tool_result correlation id, and the SAME transcript
 * entry taskNotificationWatcher.ts already reads for `toolUseResult.agentId`
 * also carries it (as the sibling `tool_result` block's own `tool_use_id` —
 * see that file's `extractToolUseId`). That's enough to link a `Task`
 * dispatch's `tool_use_id` (known at PreToolUse, threaded through the
 * `spawn` battle signal — battleBus.ts) to the CLI-internal task-id a later
 * completion names, with no new hook needed. `handleCorrelate` stamps the
 * matching battler; `handleEnd` retires by that exact stamp, falling back to
 * "oldest roaming" only when no battler was ever stamped (correlation raced
 * ahead, or predates this fix). The one part of this chain NOT verified
 * against a live transcript capture (this app can't spawn a real interactive
 * `claude` session — see hookRouter.ts's own header) is the assumption that
 * the `tool_result` block's `tool_use_id` really does sit alongside
 * `toolUseResult` on that entry, exactly as the standard Anthropic API
 * message shape implies; if that assumption is wrong for some transcript
 * variant, `extractToolUseId` returns null and correlation simply never
 * lands for that one dispatch — no crash, just today's oldest-roaming
 * fallback for that battler.
 *
 * CAVEAT: both live captures used `claude -p` (headless) rather than this
 * app's real interactive pty spawn — same HookBridge/transcript mechanism,
 * but whether an idling INTERACTIVE session still gets a completed async
 * task's notification appended promptly (rather than only on the user's
 * next real prompt) is unverified; this app is never allowed to spawn a
 * real interactive session to check. If notifications only land on the next
 * prompt, a battler just roams longer — "late is fine, early is not" still
 * holds, nothing wedges.
 *
 * INVISIBLE-SUBAGENT HARDENING (companion fix, same rework): `Battler`
 * spawns at a near-zero scale and only its own `update(dt)` grows it in —
 * so if this manager's per-tick loop ever throws while processing ONE
 * parent's battle, the old code aborted the entire `for...of` over
 * `this.battles` for that frame, silently freezing EVERY subagent's
 * poof-in, app-wide, for as long as that one poisoned entry stayed in the
 * map (GardenScene.tsx's own outer try/catch only logs via bare
 * `console.error`, which diagnosticsClient.ts does NOT capture — see that
 * file's own header — so this could run for the app's entire lifetime with
 * zero trace in harness.log). Fixed two ways: (1) each parent's battle is
 * now processed in its OWN try/catch (`update`), isolated and
 * force-concluded (`forceConcludeWave`) on a throw rather than aborting
 * every other parent's turn too; (2) every wave carries a hard outer time
 * cap (`WAVE_HARD_CAP_MS`) regardless of phase, so even a wedge this
 * isolation doesn't catch force-resolves and frees the global queue instead
 * of blocking it forever. Both paths log via `safeLogDiagnostic` — the next
 * repro of this bug (or any wedge like it) should be findable in
 * harness.log instead of only inferable from frozen counter snapshots.
 *
 * VICTORY CELEBRATION: checked against the actual sprite pipeline
 * (showdownArt.ts / assets/showdown/manifest.json — Pokemon Showdown's
 * animated gen5ani sprites, each entry a single `sourceUrl` GIF per
 * front/back sheet) and confirmed there is no celebration/cheer animation
 * for any species in this set — just one idle loop each way. Per spec, that
 * means skip silently: no fabricated frames, no repurposed unrelated
 * animation. `beginEnding`'s existing "Victory!" floating text + sparkle
 * burst + chime is left exactly as it was — it's overlay FX, not a sprite
 * swap, so it isn't the thing the spec says to skip.
 *
 * FACING IS A FIXED ARRANGEMENT, NOT COMPUTED MIRRORING. The parent always
 * ends up on the bottom-left tile of a battle pair, the challenger always
 * ends up somewhere in the top/right arc from there — never the reverse,
 * never a same-row placement (see pickChallengerStandTileFor). Because
 * native gen5ani sprites are drawn front-facing down-left and back-facing
 * up-right, an UNMIRRORED front sheet already looks like it's facing the
 * bottom-left corner and an UNMIRRORED back sheet already looks like it's
 * facing the top-right one — so the parent (back, unmirrored) and the
 * challenger (front, unmirrored) simply aim at each other by construction
 * the moment they're placed correctly. `applyBattleStance` sets both to
 * that fixed, unmirrored stance and never computes a direction from
 * position.
 *
 * Composes with the rest of the garden entirely from the outside: battlers
 * are their own lightweight class (`Battler`, reusing `WalkerSprite` +
 * `findPath`), and the parent's `Walker` is touched only through its
 * already-public `container` (position/FX) plus the two small wrapper
 * methods added for this feature (`showFloatingText`, `setForcedBackView`).
 * The evolution ceremony's exclusivity is respected by simply not touching
 * a walker's container while `walker.isEvolving` — the ceremony reparents
 * it, and fighting over its transform would corrupt both.
 *
 * DONE POKEMON STAY UNTIL DISMISSED (user-approved change, 2026-08-29):
 * `roaming -> queued -> battling -> leaving -> gone` above is now the losing
 * challenger's path ONLY through `handleEndAll`'s coarse "parent went idle
 * with no clean signal" cleanup (unchanged — a roaming sub that never even
 * reached a completion battle still just poofs). LOSING an actual completion
 * battle (`concludeWave`/`forceConcludeWave`) now ends at a new terminal
 * lifecycle, `retired`, instead: `retireSub` walks the sub back to its own
 * `wanderHome` and hands it right back to `updateRoaming` (same idle-wander
 * code roaming already uses — see `updateOneBattle`'s sub loop), so it reads
 * as an ordinary off-duty pokemon rather than one about to vanish, tinted
 * with the opaque, hue-neutral `RETIRED_TINT` as the one cheap, pixel-scale-
 * legible "off duty" cue. It
 * never re-queues (`retired` is excluded from every MIN_ROAM_MS/MAX_ROAM_MS
 * check) and is never reaped by `reapSubs` — it stays in `pb.subs`, and
 * therefore on the roster strip, until a player explicitly despawns it
 * (`despawnBattler`, SubagentRosterCard's own despawn button), which plays a
 * pokéball-recall animation (`Battler.startRecall`/battleFx.ts's
 * `spawnPokeballRecall`) before the same terminal bookkeeping `reapSubs`
 * would otherwise have done (`subagentsCleanedUp`, `onBattlerRemoved`). A
 * hard parent teardown (`forceEnd`/`dispose` -> `destroyBattle`) still sweeps
 * up `retired` (and even mid-despawn `despawning`) subs unconditionally,
 * same as any other lifecycle — no orphaned cards survive a killed session.
 * `done` (store-side, mirrored via the new `onBattlerDone(key, boolean)` DI
 * callback) is the one new piece of cross-cutting state this adds; see
 * `retireSub`/`reviveRetired`/`despawnBattler` below and store.ts's
 * `LiveBattler.done`/`setBattlerDone`. A RESUME of a task-id whose battler is
 * still sitting `retired` (not yet despawned) revives that exact battler in
 * place (`handleCorrelate` -> `reviveRetired`) rather than spawning a
 * duplicate — see `handleCorrelate`'s own updated doc comment.
 * KNOWN GAP where two of the above don't fully compose: `retiredTaskInfo` is
 * per-BattleManager-instance (never persisted), and `respawnFromStore`
 * correctly restores a retired battler as `retired` (garden-rebuild
 * recovery) but always with `taskId: null` (no correlation survives a
 * rebuild — same pre-existing limitation every other respawned battler
 * already had). So a webgl rebuild's retired battler looks right on-screen,
 * but a LATER resume of its original task-id can no longer find it via
 * `handleCorrelate`'s stamped-sub check and falls all the way through to the
 * pre-existing "never seen this task-id, nothing to resume from" no-op —
 * an accepted degradation (rare: rebuild AND a later resume of that exact
 * task-id), not a defect in the revive logic itself.
 */
import { Container } from 'pixi.js';
import type { Walker } from '../Walker';
import type { TiledMapRenderer } from '../TiledMapRenderer';
import type { PokemonAnimation } from '../showdownArt';
import { DEX_LIST, isBundled, type DexEntry } from '../dexData';
import { targetTileHeight } from '../spriteScale';
import { findPath } from '../pathfinding';
import { onBattleSignal, type BattleSignal } from './battleBus';
import { Battler } from './Battler';
import { spawnExclaimBubble, spawnHitFlash, spawnShinySparkle, spawnSparkleBurst, tickBattleFx } from './battleFx';
import { rollShiny } from '../shiny';
import { loadMegaAnimation, pickMegaId } from '../megaForms';
import { notifyBattleStart, notifyBattleEnd, playAttackSound, playVictoryChime } from '@/audio/audioEngine';
import { bumpCounter } from '@/diagnosticsCounters';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { hasPendingAsyncSubagents } from '@/pty/hookRouter';

/** Opaque, hue-neutral off-duty cue for battlers that have retired. */
const RETIRED_TINT = 0xc8c8c8;

const LUNGE_MS = 150;
const HOLD_MS = 150;
const RETURN_MS = 180;
const ATTACK_TOTAL_MS = LUNGE_MS + HOLD_MS + RETURN_MS;
/** Lunge travels this fraction of the full gap toward the opponent and back
 *  — always well short of contact, whatever the gap or sprite size (see
 *  gapTilesForBatch). */
const LUNGE_FRACTION = 0.28;
const SHAKE_MS = 180;
const FACEOFF_MS = 550;
const ENDING_MS = 550;
/** Exactly one challenger per battle now (spec: "strictly one battle at a
 *  time" — a completion battle is one subagent vs. the parent, never a
 *  batch). Kept as a named constant, not inlined as 1, because the ring/
 *  arc-slot machinery below (pickChallengerStandTileFor's 3-way arc,
 *  gapTilesForBatch) still takes an array + slot index — MAX_RING=1
 *  exercises exactly slot 0 of that existing machinery rather than
 *  deleting code that already generalizes fine. */
const MAX_RING = 1;
/** Scripted attack exchanges per skirmish before it concludes on its own —
 *  snappy by design, and the only thing that CAN conclude it now that real
 *  per-subagent signals can't be trusted for the moment-to-moment beat (see
 *  file header). */
const WAVE_ATTACKS = 2;

/** Minimum face-off gap, in tiles, between the parent and a battler — chosen
 *  so two average-sized sprites (2-2.5 drawn tiles tall) read as clearly
 *  separated rather than overlapping. Bumped up when either side's drawn
 *  height crosses LARGE_TILE_THRESHOLD (a Snorlax/Tyranitar-class sprite). */
const GAP_BASE_TILES = 3;
const GAP_LARGE_BONUS_TILES = 2;
const LARGE_TILE_THRESHOLD = 2.7;

// Roam pacing — mirrors Walker.ts's own idle wander timing/range exactly, so
// a roaming subagent reads the same as any other idling walker in the garden
// (spec: "simply roams the garden like other pokemon").
const WANDER_MIN_DELAY = 1.5;
const WANDER_MAX_DELAY = 4.5;
const WANDER_RANGE = 5;
/** Roaming task labels are deliberately occasional rather than pinned over
 *  every working battler. Each battler gets its own deterministic cycle and
 *  initial phase, so a group reads as organic instead of blinking together. */
const ROAM_LABEL_VISIBLE_MS = 3_000;
const ROAM_LABEL_CYCLE_MIN_MS = 7_000;
const ROAM_LABEL_CYCLE_MAX_MS = 10_000;
/** Live subagent tools briefly take priority over the roaming label cadence. */
const SUB_TOOL_BUBBLE_MS = 3_000;
/** How far in from the map edge a roam "home" corner sits — enough that a
 *  roaming subagent's own local jitter (WANDER_RANGE) never walks it off the
 *  map or into an unwalkable border. */
const CORNER_MARGIN = 3;

/** A subagent must roam for at least this long before a `parentDone` signal
 *  (the parent's own `Stop` hook — see `handleParentDone`) is allowed to
 *  queue its completion battle. Guards the degenerate case of a `Task`
 *  dispatched and the parent's turn ending in the same beat — without this
 *  floor that would read as a pokemon appearing and instantly dying, exactly
 *  the premature-death complaint this rework exists to fix. A genuine
 *  `SubagentStop` (`handleEnd`) bypasses it: that signal names the ONE
 *  subagent that actually just finished, not a coarse "the parent's whole
 *  turn ended" proxy, so there's nothing to guard against. */
const MIN_ROAM_MS = 15_000;

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
const MAX_ROAM_MS = 30 * 60_000;

/** Gap enforced, in ms, between the end of one completion battle and the
 *  start of the next — GLOBALLY, across every parent (the queue in
 *  `pickNextQueued`/`nextBattleEarliestAt` is what makes the lock global,
 *  not per-parent). Spec: "a few seconds of free time" so battles never
 *  overlap or instantly chain. */
const BATTLE_COOLDOWN_MIN_MS = 4_000;
const BATTLE_COOLDOWN_MAX_MS = 6_000;

/** Absolute outer bound on a single wave, whatever phase it's in — the
 *  self-healing backstop if a bug (or a corrupted battler) ever wedges a
 *  wave partway through, so a stuck battle can never block the global queue
 *  forever (see file header's invisible-subagent writeup). A normal wave
 *  (alert + a walk-in + FACEOFF_MS + WAVE_ATTACKS attacks + ENDING_MS)
 *  totals a few seconds; this is deliberately generous so it never trips a
 *  legitimately long approach walk, only a genuinely stuck one. */
const WAVE_HARD_CAP_MS = 60_000;
/** Floor under the per-wave, distance-based watchdog computed in
 *  `admitBattle` for the `alert`/`approaching` phases specifically — the
 *  only two phases bounded by something actually happening in the world (a
 *  poof finishing, a goTo() arriving) rather than a fixed clock. A roaming
 *  challenger can be anywhere on the map now (not held near the parent like
 *  the old design's fixed-radius spawn), so a flat cap alone would misfire
 *  on a genuinely long walk; this is just the minimum for a short one. */
const WAVE_STUCK_MIN_MS = 15_000;
/** Mirrors Battler.ts's own (unexported) `SPEED` — duplicated here only for
 *  the stuck-watchdog's walk-time estimate in `admitBattle`. Not imported
 *  because Battler.ts doesn't export it; if that ever changes, bump this
 *  too. */
const BATTLER_SPEED_PX_S = 44;

/** One spawned subagent's own battler + where it is in its lifecycle. */
interface SubBattler {
  key: string;
  battler: Battler;
  /** 'retired': lost its completion battle (or aged out into one) and is now
   *  off-duty — resumes ordinary wandering (`updateRoaming`), never re-
   *  queues, stays until despawned. 'despawning': a player-initiated pokéball
   *  recall is in flight (`despawnBattler`) — its own completion callback
   *  does the final removal, NOT `reapSubs` (see that method's own comment).
   *  'leaving' is now reached only via `handleEndAll`'s coarse cleanup. */
  lifecycle: 'roaming' | 'queued' | 'battling' | 'leaving' | 'retired' | 'despawning';
  /** The spawning dispatch's own `description`/`subagent_type` (see
   *  battleBus.ts's `spawn` signal) — kept on the sub (not just forwarded to
   *  the store) so a RESUME can re-materialize a battler with the same label
   *  (`handleCorrelate`'s `retiredTaskInfo`). */
  label?: string;
  /** This battler's spawning dispatch's `tool_use_id` (battler ↔ task-id
   *  correlation fix) — the one identity available at spawn time, before any
   *  CLI-internal task-id exists. Null for the regex-fallback path
   *  (ptyParser.ts, no hook payload to read one from) and for a garden
   *  context-loss recovery (`respawnFromStore`, no correlation survives a
   *  renderer rebuild). Cleared to irrelevance once `taskId` is stamped —
   *  kept around only so `handleCorrelate` can find this sub by it. */
  toolUseId: string | null;
  /** The CLI-internal task-id (`toolUseResult.agentId`) this battler's
   *  dispatch was correlated to, once `handleCorrelate` links its
   *  `toolUseId` to a completion's task-id — see the file header's battler ↔
   *  task-id correlation fix. Null until stamped; a battler that's never
   *  stamped (correlation raced ahead, or predates this fix) still falls
   *  back to `handleEnd`'s oldest-roaming heuristic exactly as before. */
  taskId: string | null;
  /** Best-effort Claude CLI-internal subagent id observed on a subagent-scoped
   *  PreToolUse. Usually absent; when the single-roamer fallback attributes
   *  one event, retaining it lets later events keep following that battler if
   *  another sibling starts roaming. */
  subagentId: string | null;
  /** Where this battler roams — chosen once at spawn (`pickRoamHome`) and
   *  never recomputed; a battler never re-enters roaming after its one
   *  completion battle. */
  wanderHome: { x: number; y: number };
  wanderTimer: number;
  wanderDelay: number;
  /** Epoch ms this battler started roaming — the basis for `MIN_ROAM_MS`
   *  (`handleParentDone`) and `handleEnd`'s oldest-first tie-break. */
  roamingSince: number;
  /** Set by `handleParentDone` when a `parentDone` signal arrives before
   *  this sub has cleared `MIN_ROAM_MS` — the epoch ms it BECOMES eligible
   *  to queue (checked every tick in `updateOneBattle`), rather than the
   *  signal just being dropped. Without this, a subagent whose parent's
   *  `Stop` arrives within the floor (plausible for a short subagent in a
   *  fast wave — the exact pattern the orchestrator's live repro showed)
   *  would only ever queue on a LATER `Stop` for that same parent, which may
   *  never come if the session doesn't prompt again — "late is fine"
   *  stretched into "never". Null while not applicable. */
  queueEligibleAt: number | null;
  /** Epoch ms this battler was queued for its completion battle — the
   *  GLOBAL FIFO tie-break across every parent's subs (`pickNextQueued`). 0
   *  until queued. */
  queuedSince: number;
  /** One-shot: logged the first tick this battler's poof-in actually
   *  finishes, so "materialized but never became visible" (the invisible-
   *  subagent bug — see file header) is findable in the diagnostics log
   *  instead of only inferable from frozen counter snapshots after the
   *  fact. */
  visibleLogged: boolean;
  /** State for the intermittent roaming label and its live-tool override. */
  roamLabelElapsedMs: number;
  roamLabelCycleMs: number;
  toolBubbleRemainingMs: number;
  roamBubbleMode: 'hidden' | 'label' | 'tool';
}

interface Attack {
  attacker: SubBattler | 'parent';
  defender: SubBattler | 'parent';
  tool: string;
  combo: number;
  elapsedMs: number;
  hitApplied: boolean;
}

interface ParentBattle {
  parentId: string;
  parentWalker: Walker;
  /** Every live subagent for this parent, any lifecycle — the only
   *  authoritative list; nothing is removed from it until fully destroyed. */
  subs: SubBattler[];
  /** The one sub currently choreographing THIS wave (empty while
   *  `wave === 'idle'`). Still an array (not a single field) so the
   *  existing arc/multi-slot machinery (pickChallengerStandTileFor,
   *  gapTilesForBatch) needs no signature change for MAX_RING=1. */
  waveRing: SubBattler[];
  wave: 'idle' | 'alert' | 'approaching' | 'faceoff' | 'looping' | 'ending';
  waveElapsedMs: number;
  waveAttacks: number;
  alertShown: boolean;
  currentAttack: Attack | null;
  lastAttackerWasParent: boolean;
  roundRobinIdx: number;
  /** Where the parent walks TO for the CURRENT wave — recomputed fresh at
   *  the start of every wave, since the parent resumes its own life between
   *  battles and may have moved. */
  parentStandTile: { x: number; y: number } | null;
  /** A tool event that arrived before the wave reached its loop (still
   *  approaching or facing off) — coalesced here instead of dropped, opened
   *  as the first scripted attack's flavor the instant face-off completes. */
  pendingTool: string | null;
  pendingCombo: number;
  nextSeq: number;
  /** Epoch ms the current wave was admitted — the basis for the stuck-
   *  watchdog checks below. */
  waveStartedAt: number;
  /** Per-wave stuck cap for the `alert`/`approaching` phases, computed fresh
   *  in `admitBattle` from the actual walk distance (see WAVE_STUCK_MIN_MS's
   *  own comment on why this can't be a flat constant anymore). */
  waveStuckCapMs: number;
  /** True from the moment `startMega` successfully applies a mega sprite
   *  (async — see that method) until `revertMega` releases it. Gates every
   *  revert call site to a no-op for the vastly more common case (no mega
   *  form, or the load hasn't landed yet) — `Walker.setTemporaryForm(null)`
   *  is itself idempotent too, so this is belt-and-braces, not the only
   *  thing standing between a mega and getting stuck. */
  megaActive: boolean;
}

export interface BattleDeps {
  map: TiledMapRenderer;
  charLayer: Container;
  /** Bundled species resolve instantly; anything else starts as a pokeball
   *  and is upgraded via loadLazyAnimation, matching GardenScene's own
   *  walkers. */
  resolveAnimation: (species: string, shiny?: boolean) => PokemonAnimation;
  loadLazyAnimation: (species: string, shiny?: boolean) => Promise<PokemonAnimation | null>;
  getRuntime: (parentId: string) => { walker: Walker } | undefined;
  /** The parent session's current species display name, for move text
   *  ("Pikachu used Grep!"). */
  getParentLabel: (parentId: string) => string;
  /** The parent session's current species dex id, for sizing the face-off gap
   *  (a Snorlax-class parent needs more room than a Pichu-class one). */
  getParentSpeciesId: (parentId: string) => string | undefined;
  /** Whether the parent session's Pokemon is shiny — mega evolution reuses
   *  the shiny variant of the mega sprite when true (falling back to
   *  non-shiny mega, then to no mega, on a 404 — see megaForms.ts). */
  getParentShiny: (parentId: string) => boolean;
  /** Evolution lines already spoken for by a live SESSION (not battlers —
   *  BattleManager tracks its own separately). */
  activeSessionLines: () => string[];
  /** Called every time a wave concludes and no new one starts right away —
   *  i.e. whenever the parent is free to resume its own normal life. */
  onBattleEnd: (parentId: string) => void;
  /** Fires the instant a wild battler actually enters the world (already
   *  added to charLayer, same moment `subagentsMaterialized` bumps) — the
   *  bridge GardenScene uses to mirror battler presence into the zustand
   *  store for the roster strip's subagent cards. `label` (parity sweep item
   *  7) — the spawning `Task`'s own description/subagent_type, straight
   *  through from the `spawn` signal (see battleBus.ts); undefined for the
   *  regex-fallback path. */
  onBattlerSpawned: (battler: { key: string; parentId: string; species: string; label?: string }) => void;
  /** Fires the instant a battler is fully torn down — the normal poof-then-
   *  cleanup path (reapSubs) and the hard force-end/dispose path
   *  (destroyBattle) both call this, so it's the complete mirror of
   *  onBattlerSpawned above regardless of how a battler's life ends. */
  onBattlerRemoved: (key: string) => void;
  /** Forwards a player click on a battler to GardenScene, which owns the
   *  selection, view-mode, and camera-focus store state. */
  onBattlerClick: (parentId: string, key: string) => void;
  /** Fires whenever a battler's `done` state changes — `true` the moment it
   *  loses its completion battle (or ages out into one) and becomes
   *  `retired`, `false` if a resumed task-id later revives that same battler
   *  in place (`reviveRetired`) instead of spawning a duplicate. One
   *  bidirectional callback rather than two, since both directions are the
   *  same store patch (`LiveBattler.done`) with the boolean flipped. */
  onBattlerDone: (key: string, done: boolean) => void;
}

function tileKey(t: { x: number; y: number }): string {
  return `${t.x},${t.y}`;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function roamingBubbleTiming(key: string): { elapsedMs: number; cycleMs: number } {
  const seed = hashString(key);
  const cycleMs = ROAM_LABEL_CYCLE_MIN_MS + (seed % (ROAM_LABEL_CYCLE_MAX_MS - ROAM_LABEL_CYCLE_MIN_MS + 1));
  return { elapsedMs: seed % cycleMs, cycleMs };
}

/** Nearest walkable tile to `center` within [minDist, maxDist] (Manhattan),
 *  shuffled among ties for variety. When `reachableFrom` is given, a
 *  candidate must also have an actual BFS path from it — a tile that merely
 *  passes `isWalkable` can still sit in a disconnected pocket (the far side
 *  of a wall/pond), which would leave a battler assigned to walk there stuck
 *  forever (goTo fails silently, by design, to avoid teleporting). Null if
 *  nothing in range qualifies. */
function findNearbyWalkable(
  map: TiledMapRenderer,
  center: { x: number; y: number },
  minDist: number,
  maxDist: number,
  avoid?: ReadonlySet<string>,
  reachableFrom?: { x: number; y: number },
  /** Extra positional constraint on the ABSOLUTE candidate tile — e.g. "stay
   *  in the parent's NE quadrant" — evaluated alongside walkability/avoid. */
  filter?: (candidate: { x: number; y: number }) => boolean
): { x: number; y: number } | null {
  const candidates: { x: number; y: number; d: number }[] = [];
  for (let dx = -maxDist; dx <= maxDist; dx++) {
    for (let dy = -maxDist; dy <= maxDist; dy++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < minDist || d > maxDist) continue;
      candidates.push({ x: center.x + dx, y: center.y + dy, d });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const c of candidates) {
    if (avoid?.has(tileKey(c))) continue;
    if (!map.isWalkable(c.x, c.y)) continue;
    if (filter && !filter(c)) continue;
    if (reachableFrom && findPath(map, reachableFrom, c) === null) continue;
    return { x: c.x, y: c.y };
  }
  return null;
}

export class BattleManager {
  private battles = new Map<string, ParentBattle>();
  private unsubscribe: () => void;
  /** Epoch ms before which no NEW battle may be admitted globally — the
   *  cooldown gap enforced after every wave concludes. 0 initially (nothing
   *  has battled yet, so nothing to cool down from). */
  private nextBattleEarliestAt = 0;
  /** Battler ↔ task-id correlation fix (2026-08-29) — species/label memory
   *  for every task-id `handleEnd` has ever retired, keyed by the CLI-
   *  internal task-id. Consulted by `handleCorrelate` when a task-id
   *  dispatches async again with no live battler carrying it: a RESUME,
   *  which should poof the same pokemon back in rather than staying
   *  invisible (BACKLOG "resumed agents are invisible"). Never pruned —
   *  bounded by how many subagents a session actually completes, not by
   *  anything unbounded. */
  private retiredTaskInfo = new Map<string, { species: string; label?: string }>();

  constructor(private deps: BattleDeps) {
    this.unsubscribe = onBattleSignal((sig) => this.onSignal(sig));
  }

  /** True while this parent's walker should stay frozen in battle stance —
   *  i.e. a completion skirmish is actively choreographing. False while its
   *  subagents are merely roaming (the parent has resumed its own normal
   *  life), even though `subs` may still be non-empty. */
  isBattling(parentId: string): boolean {
    const pb = this.battles.get(parentId);
    return !!pb && pb.wave !== 'idle';
  }

  isMidAttack(parentId: string): boolean {
    return this.battles.get(parentId)?.currentAttack != null;
  }

  /** True while ANY parent has a live `ParentBattle` entry — a wave in
   *  progress, or subagents merely roaming/queued/retired. Dirty-flag
   *  rendering (renderDirty.ts, GardenScene.tsx's ticker): rather than
   *  instrumenting every individual Battler movement/lunge/poof and battleFx
   *  effect, this one blanket flag is deliberately coarse — `this.battles`
   *  only ever holds a parent with something actually live (see
   *  `updateOneBattle`'s own `finishedParents` cleanup), so "any entry
   *  exists" already means "something in this subsystem could be moving
   *  this frame." */
  hasActiveBattles(): boolean {
    return this.battles.size > 0;
  }

  /** World position of a live battler's sprite, by its store key (the same
   *  key `onBattlerSpawned`/`onBattlerRemoved` mirror into `LiveBattler`) —
   *  GardenScene's ticker uses this to pan the camera onto a subagent's own
   *  pokemon (`focusBattlerKey`) instead of its parent's walker. Scans every
   *  live parent's `subs` rather than a separate index — battler counts per
   *  parent are small and this is only called once a frame while a focus is
   *  active. Undefined once the battler is torn down. */
  getBattlerPosition(key: string): { x: number; y: number } | undefined {
    for (const pb of this.battles.values()) {
      const sub = pb.subs.find((s) => s.key === key);
      if (sub) return { x: sub.battler.container.x, y: sub.battler.container.y };
    }
    return undefined;
  }

  private handleBattlerClick(parentId: string, key: string): void {
    const sub = this.battles.get(parentId)?.subs.find((candidate) => candidate.key === key);
    if (!sub || sub.lifecycle === 'leaving' || sub.lifecycle === 'despawning') return;
    this.deps.onBattlerClick(parentId, key);
  }

  /** Workspace scoping (Phase 8.7): toggles a parent's battle visuals on or
   *  off without touching the state machine — a battle for a session in an
   *  inactive workspace keeps running (roam/battle all still progress, same
   *  as any other background session's work) but stays invisible until that
   *  workspace is active again. Needed because a challenger's
   *  `Battler.container` is a direct child of `charLayer` (absolute map
   *  coordinates, same space `Walker.container` uses), NOT nested under the
   *  parent walker's own container — so GardenScene setting the parent
   *  walker invisible doesn't cascade to it; this is the other half of that
   *  same toggle, called alongside it every reconcile. No-op if `parentId`
   *  has no live subagents. */
  setVisible(parentId: string, visible: boolean): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    for (const sub of pb.subs) {
      sub.battler.container.visible = visible;
      sub.battler.bubbleContainer.visible = visible;
    }
  }

  /** Call when a parent session's own walker is torn down (session ended)
   *  while any subagent (roaming/queued/battling/leaving) was still alive —
   *  drops everything with no ceremony, guaranteeing no stuck pokemon
   *  survives a killed session. */
  forceEnd(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    // A wave still active when a session is force-ended never reaches
    // concludeWave/handleEndAll's own bump — without this, killing a session
    // mid-skirmish would leave battlesStarted permanently ahead of
    // battlesResolved (see diagnosticsCounters.ts's divergence check).
    if (pb.wave !== 'idle') bumpCounter('battlesResolved');
    this.destroyBattle(pb);
    this.battles.delete(parentId);
    notifyBattleEnd(parentId);
  }

  dispose(): void {
    this.unsubscribe();
    for (const [parentId, pb] of this.battles) {
      if (pb.wave !== 'idle') bumpCounter('battlesResolved');
      this.destroyBattle(pb);
      notifyBattleEnd(parentId);
    }
    this.battles.clear();
  }

  /** Garden context-loss recovery (GardenScene.tsx's `rebuild`, 2026-08-29):
   *  a fresh BattleManager starts with `this.battles` empty, but the store's
   *  `battlers` slice may still list subagents that were alive when the old
   *  renderer died — this recreates a roaming sprite for each one, reusing
   *  the same battler-construction steps `handleSpawn` uses (just with a
   *  known species instead of a random draw, and without re-adding to the
   *  store, which already has these entries). Not a faithful restore of
   *  lifecycle phase (mid-battle choreography, exact roam position, shiny
   *  state) — every recovered battler simply starts fresh in 'roaming' (or,
   *  since the done/retired follow-up, 'retired' when the store's own
   *  `done` flag for it is true — a done battler's off-duty status must
   *  survive a rebuild, not silently resurrect it into an active roamer),
   *  same latitude GardenScene's own walker rebuild takes ("position can
   *  reset to spawn/wander — fine"). Returns the keys that could NOT be
   *  recreated (parent's walker missing, or the species has no sprite) —
   *  the caller drops those from the store rather than leaving a roster
   *  card with no sprite behind it. */
  respawnFromStore(
    entries: { key: string; parentId: string; species: string; label?: string; done?: boolean }[]
  ): string[] {
    const failed: string[] = [];
    for (const entry of entries) {
      const rt = this.deps.getRuntime(entry.parentId);
      const species = DEX_LIST.find((e) => e.id === entry.species && e.hasSprite);
      if (!rt || !species) {
        failed.push(entry.key);
        continue;
      }
      let pb = this.battles.get(entry.parentId);
      if (!pb) {
        pb = this.createBattle(entry.parentId, rt.walker);
        this.battles.set(entry.parentId, pb);
      }
      // Shiny isn't tracked in the store's `LiveBattler` slice, so a
      // recovered battler always comes back non-shiny — the one known gap
      // in this recovery path's fidelity.
      const animation = this.deps.resolveAnimation(species.id, false);
      const home = this.pickRoamHome(pb, pb.parentWalker.tile);
      const battler = new Battler({
        map: this.deps.map,
        animation,
        species,
        spawnTile: home,
        label: entry.label,
        onClick: () => this.handleBattlerClick(entry.parentId, entry.key)
      });
      this.deps.charLayer.addChild(battler.container);
      this.deps.charLayer.addChild(battler.bubbleContainer);
      if (entry.done) battler.container.tint = RETIRED_TINT; // same off-duty cue retireSub applies live
      const bubbleTiming = roamingBubbleTiming(entry.key);
      const sub: SubBattler = {
        key: entry.key,
        battler,
        lifecycle: entry.done ? 'retired' : 'roaming',
        label: entry.label,
        // No correlation survives a renderer rebuild — this sub falls back
        // to handleEnd's oldest-roaming heuristic if its real completion
        // notification arrives after recovery, same as any other never-
        // stamped battler.
        toolUseId: null,
        taskId: null,
        subagentId: null,
        wanderHome: home,
        wanderTimer: 0,
        wanderDelay: WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY),
        roamingSince: Date.now(),
        queuedSince: 0,
        queueEligibleAt: null,
        visibleLogged: false,
        roamLabelElapsedMs: bubbleTiming.elapsedMs,
        roamLabelCycleMs: bubbleTiming.cycleMs,
        toolBubbleRemainingMs: 0,
        roamBubbleMode: 'hidden'
      };
      pb.subs.push(sub);
      if (!isBundled(species.id)) {
        void this.deps.loadLazyAnimation(species.id, false).then((real) => {
          if (real && pb!.subs.includes(sub)) battler.setAnimation(real);
        });
      }
    }
    return failed;
  }

  /**
   * PHASE ISOLATION (2026-08-29, companion to the battleFx.ts fix): every
   * phase below — the global FX tick, the global queue pump, and each
   * parent's own update — runs in its OWN try/catch. Before this, only the
   * per-parent loop was isolated; the global FX tick sat UNGUARDED at the top
   * of this function, so a throw inside it (see battleFx.ts's `tickBattleFx`
   * doc comment for the real 2026-08-28 production crash this caused) aborted
   * this ENTIRE method before the per-parent loop — or even the queue pump —
   * ever ran, every single frame, for as long as the poisoned state
   * persisted. `tickBattleFx` now self-heals on its own (battleFx.ts), so
   * this outer isolation is a backstop, not the primary fix — but the same
   * "one phase throwing must never block the others, this frame or any
   * future one" philosophy the per-parent loop already used is now applied
   * to the two GLOBAL phases too, so nothing here can ever wedge the same
   * way again even if a future change adds unguarded work to either of them.
   */
  update(dt: number): void {
    // Phase 1: global FX tick.
    try {
      tickBattleFx(dt);
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('battle', 'error', 'battle FX tick threw outside its own isolation — skipping this frame', {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }

    const finishedParents: string[] = [];

    // Phase 2: global queue pump (spec: "strictly one battle at a time...
    // across different parent sessions"): derived every tick, not tracked as
    // separate mutable lock state — a stray/abandoned ParentBattle can never
    // desync a derived check from reality the way a manually-maintained
    // "which parent currently holds the lock" field could (see file
    // header). At most one pb may be mid-wave at once; when none is, and the
    // cooldown gap has elapsed, admit the globally-oldest queued sub.
    try {
      const anyWaveActive = Array.from(this.battles.values()).some((pb) => pb.wave !== 'idle');
      if (!anyWaveActive && Date.now() >= this.nextBattleEarliestAt) {
        const next = this.pickNextQueued();
        if (next) this.admitBattle(next.pb, next.sub);
      }
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('battle', 'error', 'global battle queue pump threw — skipping this frame', {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }

    // Phase 3: each parent's own update, already isolated per-parent below —
    // unchanged by this restructure.
    for (const [parentId, pb] of this.battles) {
      try {
        this.updateOneBattle(pb, dt, finishedParents);
      } catch (err) {
        // One poisoned parent must never wedge every other parent's battles.
        // A throw here used to abort this entire for...of loop, silently
        // freezing EVERY subagent's poof-in app-wide for as long as this pb
        // stayed in `this.battles` — see file header's invisible-subagent
        // writeup. Isolated per-parent and force-concluded so the global
        // queue can always make progress, and actually logged this time
        // (GardenScene.tsx's outer catch only reaches bare console.error,
        // which diagnosticsClient.ts does not capture).
        bumpCounter('battleSignalErrors');
        safeLogDiagnostic('battle', 'error', 'parent battle update threw — force-concluding', {
          parentId,
          wave: pb.wave,
          subCount: pb.subs.length,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err)
        });
        this.forceConcludeWave(pb);
      }
    }

    for (const parentId of finishedParents) this.battles.delete(parentId);
  }

  private updateOneBattle(pb: ParentBattle, dt: number, finishedParents: string[]): void {
    if (pb.parentWalker.isEvolving) {
      // The ceremony owns the parent's container for its duration — don't
      // touch positions; just keep every subagent roaming/battling/poofing
      // in place.
      for (const sub of pb.subs) {
        if (sub.lifecycle === 'roaming') this.updateRoamingBubble(sub, dt);
        sub.battler.update(dt);
      }
      this.reapSubs(pb);
      if (pb.subs.length === 0 && pb.wave === 'idle') finishedParents.push(pb.parentId);
      return;
    }

    // Distance-aware watchdog for `alert`/`approaching` specifically — see
    // waveStuckCapMs's own comment. Absolute hard cap covers every phase as
    // a self-healing backstop (file header).
    if (
      (pb.wave === 'alert' || pb.wave === 'approaching') &&
      Date.now() - pb.waveStartedAt >= pb.waveStuckCapMs
    ) {
      this.concludeWave(pb);
    }
    if (pb.wave !== 'idle' && Date.now() - pb.waveStartedAt >= WAVE_HARD_CAP_MS) {
      safeLogDiagnostic('battle', 'warn', 'wave exceeded hard cap — force-concluding', {
        parentId: pb.parentId,
        wave: pb.wave
      });
      this.forceConcludeWave(pb);
    }

    switch (pb.wave) {
      case 'alert':
        this.updateAlert(pb);
        break;
      case 'approaching':
        this.updateApproaching(pb);
        break;
      case 'faceoff':
        this.updateFaceoff(pb, dt);
        break;
      case 'looping':
        if (pb.currentAttack) this.advanceAttack(pb, dt);
        break;
      case 'ending':
        this.updateEnding(pb, dt);
        break;
      case 'idle':
        break;
    }

    // Mutual facing, re-derived every tick from actual current tiles —
    // covers the moment face-off begins, every attack's target swap, and
    // self-corrects if a lunge or an evolution reset either sprite's
    // mirroring in between.
    if (pb.wave === 'faceoff' || pb.wave === 'looping') this.applyBattleStance(pb);

    for (const sub of pb.subs) {
      if (sub.lifecycle === 'roaming') {
        this.updateRoaming(sub, dt);
        // Bug B fix (2026-08-29) — re-checks `hasPendingAsyncSubagents`
        // (hookRouter.ts) rather than firing unconditionally once the floor
        // elapses: `handleParentDone` already skipped queuing this sub
        // immediately (it was younger than MIN_ROAM_MS when Stop arrived),
        // but the counter it read THEN can lag the transcript by up to one
        // poll interval (~2s) — a Stop firing ~200ms after an async
        // dispatch can land before the poller has ever seen the launch
        // line, so `queueEligibleAt` alone would otherwise still fire this
        // unconditionally and reproduce the exact premature-death race this
        // whole fix exists to close. `queueEligibleAt` is deliberately left
        // set (not cleared) when this re-check suppresses — it just retries
        // every tick until either the count clears (a genuinely synchronous
        // dispatch, or the poller catches up and this sub concludes on its
        // own task-notification via `handleEnd` instead) or, in the
        // pathological case neither ever arrives, the sub simply keeps
        // roaming (honest degradation, not a wedge — see hookRouter.ts's
        // `hasPendingAsyncSubagents` and taskNotificationWatcher.ts's header
        // for the full evidence this is built on).
        if (
          sub.queueEligibleAt !== null &&
          Date.now() >= sub.queueEligibleAt &&
          !hasPendingAsyncSubagents(pb.parentId)
        ) {
          this.queueForBattle(sub);
        } else if (pb.wave === 'idle' && Date.now() - sub.roamingSince >= MAX_ROAM_MS) {
          // Age-based self-queue (see MAX_ROAM_MS's own comment) — fires
          // regardless of hasPendingAsyncSubagents, since that counter (and
          // therefore queueEligibleAt above) can get stuck permanently for a
          // subagent that died without a terminal notification, or whose
          // real completion was deduped by task-id and swallowed. This is
          // the source fix for the roster-leak bug: without it, either
          // failure mode leaves this sub 'roaming' — and its card on the
          // roster strip — forever.
          safeLogDiagnostic('battle', 'warn', 'battler aged out of roaming — queuing for completion battle', {
            parentId: pb.parentId,
            key: sub.key,
            species: sub.battler.species.id,
            ageMs: Date.now() - sub.roamingSince
          });
          this.queueForBattle(sub);
        }
      } else if (sub.lifecycle === 'retired') {
        // Off-duty, done follow-up: the exact same idle wander 'roaming'
        // uses — it just never runs the queue-eligibility checks above, so a
        // retired battler can wander forever without ever fighting again.
        this.updateRoaming(sub, dt);
      }
      sub.battler.update(dt);
      if (!sub.visibleLogged && !sub.battler.isSpawning) {
        sub.visibleLogged = true;
        safeLogDiagnostic('battle-spawn', 'info', 'battler visible (poof-in complete)', {
          parentId: pb.parentId,
          key: sub.key
        });
      }
    }
    this.reapSubs(pb);
    this.applyPositions(pb);
    for (const sub of pb.subs) sub.battler.syncBubblePosition();

    if (pb.subs.length === 0 && pb.wave === 'idle') finishedParents.push(pb.parentId);
  }

  // --- signal handling -------------------------------------------------

  private onSignal(sig: BattleSignal): void {
    switch (sig.type) {
      case 'spawn':
        this.handleSpawn(sig.parentId, sig.label, sig.toolUseId);
        break;
      case 'attack':
        this.handleAttack(sig.parentId, sig.tool);
        break;
      case 'subTool':
        this.handleSubTool(sig.parentId, sig.subagentId, sig.tool, sig.toolTarget);
        break;
      case 'end':
        this.handleEnd(sig.parentId, sig.taskId);
        break;
      case 'endAll':
        this.handleEndAll(sig.parentId);
        break;
      case 'parentDone':
        this.handleParentDone(sig.parentId);
        break;
      case 'correlate':
        this.handleCorrelate(sig.parentId, sig.toolUseId, sig.taskId);
        break;
    }
  }

  private handleSpawn(parentId: string, label?: string, toolUseId?: string): void {
    const rt = this.deps.getRuntime(parentId);
    if (!rt) return;
    let pb = this.battles.get(parentId);
    if (!pb) {
      pb = this.createBattle(parentId, rt.walker);
      this.battles.set(parentId, pb);
    }

    const species = this.pickSpecies();
    if (!species) return; // dex exhausted — extremely unlikely; just drop

    // A wild challenger is a fresh roll every spawn — same odds as a session
    // (Phase 5 §5), independent of it (battlers never evolve, so there's no
    // "stays shiny" state to track beyond this one Battler's lifetime).
    const shiny = rollShiny();
    const animation = this.deps.resolveAnimation(species.id, shiny);
    const home = this.pickRoamHome(pb, pb.parentWalker.tile);
    const key = `${parentId}#${pb.nextSeq++}`;
    const battler = new Battler({
      map: this.deps.map,
      animation,
      species,
      spawnTile: home,
      label,
      onClick: () => this.handleBattlerClick(parentId, key)
    });
    this.deps.charLayer.addChild(battler.container);
    this.deps.charLayer.addChild(battler.bubbleContainer);
    const bubbleTiming = roamingBubbleTiming(key);

    const sub: SubBattler = {
      key,
      battler,
      lifecycle: 'roaming',
      label,
      toolUseId: toolUseId ?? null,
      taskId: null,
      subagentId: null,
      wanderHome: home,
      wanderTimer: 0,
      wanderDelay: WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY),
      roamingSince: Date.now(),
      queuedSince: 0,
      queueEligibleAt: null,
      visibleLogged: false,
      roamLabelElapsedMs: bubbleTiming.elapsedMs,
      roamLabelCycleMs: bubbleTiming.cycleMs,
      toolBubbleRemainingMs: 0,
      roamBubbleMode: 'hidden'
    };
    pb.subs.push(sub);
    this.deps.onBattlerSpawned({ key: sub.key, parentId, species: species.id, label });
    // "Materialized" (vs. hookRouter.ts's "spawned" bump on the Task tool
    // call itself) — this is the point a real battler enters the world,
    // already added to charLayer above; the gap between the two counters is
    // exactly the `!rt`/`!species` guards above. Logged too (not just
    // counted) so a repro of the invisible-subagent bug is findable by the
    // spawn that never got to `visibleLogged` (see that field's comment).
    bumpCounter('subagentsMaterialized');
    safeLogDiagnostic('battle-spawn', 'info', 'battler materialized', {
      parentId,
      species: species.id,
      tile: home
    });

    if (shiny) {
      spawnShinySparkle(battler.container, -battler.drawnHeight - 8);
      battler.showMoveText('Shiny!');
    }

    // A shiny pick always needs the lazy fetch too (see resolveAnimation),
    // even for an otherwise-bundled species.
    if (!isBundled(species.id) || shiny) {
      void this.deps.loadLazyAnimation(species.id, shiny).then((real) => {
        if (real && pb!.subs.includes(sub)) battler.setAnimation(real);
      });
    }
  }

  private handleAttack(parentId: string, tool: string): void {
    const pb = this.battles.get(parentId);
    if (!pb || pb.waveRing.length === 0) return;
    if (pb.wave !== 'looping') {
      // Still approaching or facing off — the walk-in is the point, so don't
      // shortcut it. Coalesce into a pending combo that flavors the first
      // scripted attack the instant face-off completes instead of dropping
      // the event.
      pb.pendingCombo++;
      pb.pendingTool = tool;
      return;
    }
    if (pb.parentWalker.isEvolving) return; // dropped; the ceremony is exclusive
    // The real tool line is the most useful label for the battler's bubble.
    // Pre-faceoff signals remain queued as data only: the spawn label owns the
    // bubble while the battler is still approaching.
    for (const sub of pb.waveRing) sub.battler.showAttack(tool);
    if (pb.currentAttack) {
      // Coalesce rapid events into the current beat instead of queuing a
      // replay per event — restart its timeline so the hit/text re-fires
      // with the bumped combo count.
      pb.currentAttack.combo++;
      pb.currentAttack.tool = tool;
      pb.currentAttack.elapsedMs = 0;
      pb.currentAttack.hitApplied = false;
    }
    // Between scripted beats there's nothing to coalesce into — the wave's
    // own scripted progression (not real signals) decides when it's done.
  }

  /** Best-effort live-tool attribution for a subagent-scoped hook. The
   *  correlated task-id is the strongest match. A previously remembered
   *  subagent id is the next exact match; this is what lets a single-battler
   *  fallback continue to follow that battler after siblings appear. Only
   *  then is the one-live-roamer fallback allowed. */
  private handleSubTool(parentId: string, subagentId: string, tool: string, toolTarget: string): void {
    if (!tool) return;
    const pb = this.battles.get(parentId);
    if (!pb) return;

    const correlated = pb.subs.find((sub) => sub.taskId === subagentId);
    if (correlated) {
      if (correlated.lifecycle === 'roaming') this.showSubagentTool(correlated, subagentId, tool, toolTarget);
      return;
    }

    const remembered = pb.subs.find((sub) => sub.subagentId === subagentId);
    if (remembered) {
      if (remembered.lifecycle === 'roaming') this.showSubagentTool(remembered, subagentId, tool, toolTarget);
      return;
    }

    const roaming = pb.subs.filter((sub) => sub.lifecycle === 'roaming');
    if (roaming.length !== 1) return;

    const target = roaming[0];
    target.subagentId = subagentId;
    this.showSubagentTool(target, subagentId, tool, toolTarget);
  }

  private showSubagentTool(sub: SubBattler, subagentId: string, tool: string, toolTarget: string): void {
    sub.subagentId = subagentId;
    sub.toolBubbleRemainingMs = SUB_TOOL_BUBBLE_MS;
    sub.roamBubbleMode = 'tool';
    sub.battler.showAttack(tool, toolTarget);
  }

  /** A real per-subagent completion (`onSubagentTaskNotification`, see file
   *  header). Battler ↔ task-id correlation fix (2026-08-29): when `taskId`
   *  names the CLI-internal task-id that finished, retires the EXACT roaming
   *  battler already stamped with it (`handleCorrelate`) — recording its
   *  species/label in `retiredTaskInfo` first, so a later RESUME can
   *  re-materialize the same pokemon. Falls back to queuing the OLDEST
   *  currently-roaming subagent for the parent — the same "no real
   *  correlation, do something reasonable" position the regex-fallback path
   *  (`endAll`) is already in — only when no battler was ever stamped with
   *  `taskId` (correlation raced ahead of this notification, or this battler
   *  predates the fix), or when no `taskId` is available at all (shouldn't
   *  happen for this signal's one real caller today, but kept honest for any
   *  future caller). Bypasses `MIN_ROAM_MS` either way — this signal names
   *  one specific subagent's real completion, not a coarse per-turn proxy,
   *  so there's nothing to guard against. */
  private handleEnd(parentId: string, taskId?: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    if (taskId) {
      const stamped = pb.subs.find((s) => s.taskId === taskId && s.lifecycle === 'roaming');
      if (stamped) {
        this.retiredTaskInfo.set(taskId, { species: stamped.battler.species.id, label: stamped.label });
        this.queueForBattle(stamped);
        return;
      }
    }
    let oldest: SubBattler | null = null;
    for (const sub of pb.subs) {
      if (sub.lifecycle !== 'roaming') continue;
      if (!oldest || sub.roamingSince < oldest.roamingSince) oldest = sub;
    }
    if (oldest) {
      // Best-effort even in the fallback path: without recording SOMETHING
      // under `taskId`, a genuine later resume of this exact task-id would
      // find no memory to re-materialize from and stay invisible — the same
      // gap this whole fix exists to close, just for the narrower case of a
      // battler that was never stamped. The tradeoff is recording the wrong
      // species if `oldest` isn't actually the sub that finished (possible
      // under concurrency) — accepted, since the alternative is certain
      // invisibility rather than a possibly-wrong pokemon on resume.
      if (taskId) this.retiredTaskInfo.set(taskId, { species: oldest.battler.species.id, label: oldest.label });
      this.queueForBattle(oldest);
    }
  }

  /** Battler ↔ task-id correlation (2026-08-29 fix) — see battleBus.ts's
   *  'correlate' signal and taskNotificationWatcher.ts's `battle:
   *  taskCorrelated` for where the pair comes from. Two outcomes:
   *   1. ORDINARY: the dispatch that owns `toolUseId` already spawned a
   *      battler (`handleSpawn`) and is just waiting to be told its
   *      CLI-internal task-id — stamp it, so `handleEnd` can retire it
   *      exactly instead of guessing.
   *   2. RESUME: no live battler carries `toolUseId` at all — the same
   *      task-id dispatched async again after its earlier battler already
   *      fully faded (only possible because taskNotificationWatcher.ts
   *      un-guards a task-id from its dedupe set the moment it sees this
   *      exact relaunch). Re-materializes a fresh roaming battler from
   *      `retiredTaskInfo`'s remembered species/label — same species,
   *      poofing back in — stamped directly with `taskId` (no need to wait
   *      for a fresh spawn->correlate round trip; it's already known here).
   *      UNVERIFIED assumption this whole branch rests on (no live capture
   *      of a real resume/SendMessage relaunch — this app can't spawn a real
   *      interactive `claude` session): that a resume actually writes a
   *      FRESH `toolUseResult.isAsync` transcript line carrying the SAME
   *      `agentId`, the way a completely independent dispatch would. The
   *      CLI's own "same task-id may notify more than once" note (see
   *      taskNotificationWatcher.ts's header) only documents the
   *      NOTIFICATION side re-firing, not that the LAUNCH side re-fires too
   *      — if a resume turns out not to produce a new async-launch line for
   *      that agentId, this branch is simply never reached; the resumed
   *      run's eventual second completion still isn't swallowed (the
   *      `notified` un-guard is independent of this), it just falls through
   *      `handleEnd` to the oldest-roaming fallback instead of a proper
   *      respawn — a real but strictly narrower version of the original bug.
   *  NOTE: `pb` may not exist here — a resume can arrive after the original
   *  battler's completion battle concluded and this parent's `ParentBattle`
   *  was reaped from `this.battles` entirely (`update`'s `finishedParents`
   *  cleanup) — exactly the state the BACKLOG repro describes ("a completed
   *  async agent is CONTINUED"). Only the RESUME branch may create one (same
   *  `!rt` guard `handleSpawn` uses); the STAMP branch below needs an
   *  existing `pb` since there's nothing to stamp otherwise.
   *  Guards against double-spawn: if ANY live sub — including one mid-poof
   *  (`'leaving'`) — already carries `taskId`, this is a duplicate/no-op:
   *  the original is still alive (or still finishing its exit), or already
   *  correctly stamped. ONE exception (done/retired follow-up, 2026-08-29):
   *  a sub that's `'retired'` (done, off-duty, still on the map — not yet
   *  despawned) is NOT a live duplicate to guard against, it's the exact
   *  battler this resume should revive in place — `reviveRetired` flips it
   *  back to `'roaming'` (done=false) instead of the RESUME branch further
   *  down spawning a second, duplicate pokemon for the same task-id. A sub
   *  that's `'despawning'` (a pokéball recall already in flight) still hits
   *  the plain no-op below — reviving mid-recall would fight its own
   *  teardown. */
  private handleCorrelate(parentId: string, toolUseId: string, taskId: string): void {
    let pb = this.battles.get(parentId);
    const stampedElsewhere = pb?.subs.find((s) => s.taskId === taskId);
    if (stampedElsewhere) {
      if (stampedElsewhere.lifecycle === 'retired') this.reviveRetired(stampedElsewhere);
      return;
    }
    const bySpawn = pb?.subs.find((s) => s.toolUseId === toolUseId && s.taskId === null);
    if (bySpawn) {
      bySpawn.taskId = taskId;
      // Recorded here too (not just in handleEnd) so a battler that exits
      // via a path other than handleEnd (handleEndAll, forceConcludeWave,
      // the MAX_ROAM_MS age-out self-queue) still leaves resume-respawn
      // memory behind.
      this.retiredTaskInfo.set(taskId, { species: bySpawn.battler.species.id, label: bySpawn.label });
      return;
    }

    const info = this.retiredTaskInfo.get(taskId);
    if (!info) return; // never seen this task-id before — nothing to resume from
    const species = DEX_LIST.find((e) => e.id === info.species && e.hasSprite);
    if (!species) return;
    const rt = this.deps.getRuntime(parentId);
    if (!rt) return; // parent session's own walker is gone — nothing to roam beside
    if (!pb) {
      pb = this.createBattle(parentId, rt.walker);
      this.battles.set(parentId, pb);
    }
    const animation = this.deps.resolveAnimation(species.id, false);
    const home = this.pickRoamHome(pb, pb.parentWalker.tile);
    const key = `${parentId}#${pb.nextSeq++}`;
    const battler = new Battler({
      map: this.deps.map,
      animation,
      species,
      spawnTile: home,
      label: info.label,
      onClick: () => this.handleBattlerClick(parentId, key)
    });
    this.deps.charLayer.addChild(battler.container);
    this.deps.charLayer.addChild(battler.bubbleContainer);
    const bubbleTiming = roamingBubbleTiming(key);
    const sub: SubBattler = {
      key,
      battler,
      lifecycle: 'roaming',
      label: info.label,
      toolUseId,
      taskId,
      subagentId: null,
      wanderHome: home,
      wanderTimer: 0,
      wanderDelay: WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY),
      roamingSince: Date.now(),
      queuedSince: 0,
      queueEligibleAt: null,
      visibleLogged: false,
      roamLabelElapsedMs: bubbleTiming.elapsedMs,
      roamLabelCycleMs: bubbleTiming.cycleMs,
      toolBubbleRemainingMs: 0,
      roamBubbleMode: 'hidden'
    };
    pb.subs.push(sub);
    this.deps.onBattlerSpawned({ key: sub.key, parentId, species: species.id, label: info.label });
    bumpCounter('subagentsMaterialized');
    safeLogDiagnostic('battle-spawn', 'info', 'battler re-materialized for a resumed subagent', {
      parentId,
      species: species.id,
      taskId,
      tile: home
    });
    if (!isBundled(species.id)) {
      void this.deps.loadLazyAnimation(species.id, false).then((real) => {
        if (real && pb!.subs.includes(sub)) battler.setAnimation(real);
      });
    }
  }

  /** The parent session's own turn fully ended (`Stop`, via hookRouter.ts).
   *  A `Task` tool call blocks the parent's turn until it genuinely
   *  completes, so this is a DETERMINISTIC signal that every subagent
   *  dispatched this turn is actually done — see file header on why that
   *  replaces the old wall-clock fallback rather than just tuning it. Queues
   *  every roaming sub that's already cleared `MIN_ROAM_MS`; a sub still
   *  younger than that is scheduled to queue itself the MOMENT it clears the
   *  floor (`queueEligibleAt`, checked every tick in `updateOneBattle`)
   *  rather than the signal being dropped — a session that never prompts
   *  again after this turn would otherwise leave it roaming forever, which
   *  is "late" stretched into "never", not the "late is fine" the spec
   *  actually asks for. */
  private handleParentDone(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    const now = Date.now();
    for (const sub of pb.subs) {
      if (sub.lifecycle !== 'roaming') continue;
      if (now - sub.roamingSince >= MIN_ROAM_MS) {
        this.queueForBattle(sub);
      } else if (sub.queueEligibleAt === null) {
        sub.queueEligibleAt = sub.roamingSince + MIN_ROAM_MS;
      }
    }
  }

  private queueForBattle(sub: SubBattler): void {
    sub.lifecycle = 'queued';
    sub.queuedSince = Date.now();
    sub.queueEligibleAt = null;
    sub.toolBubbleRemainingMs = 0;
    sub.roamBubbleMode = 'hidden';
    sub.battler.showBubbleLabel();
  }

  /** Regex-fallback heuristic (or a general "give up on this parent's
   *  subagents" signal): the parent went idle/blocked with no clean
   *  per-subagent completion signal available. No re-fight ceremony for
   *  potentially several stragglers at once — just a clean, snappy poof,
   *  matching this signal's own coarse, "probably all done" nature. Left
   *  deliberately unchanged in behavior from before this rework: ptyParser.ts
   *  also fires this when the parent merely LOOKS blocked at a permission
   *  prompt it's about to resume from, and upgrading that case to a visible
   *  walk-up-and-battle would be exactly the false-positive premature death
   *  this rework is fixing elsewhere, not a new "completion" signal to
   *  extend. Done/retired follow-up: a `'retired'` (done, off-duty) or
   *  `'despawning'` (recall already in flight) sub is explicitly skipped
   *  too, same as one already `'leaving'` — this signal fires on a merely
   *  BLOCKED parent as often as a genuinely done one (see above), so it must
   *  never be the thing that silently poofs away a battler the user hasn't
   *  chosen to despawn yet. */
  private handleEndAll(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    for (const sub of pb.subs) {
      if (sub.lifecycle === 'leaving' || sub.lifecycle === 'retired' || sub.lifecycle === 'despawning') continue;
      sub.lifecycle = 'leaving';
      sub.toolBubbleRemainingMs = 0;
      sub.roamBubbleMode = 'hidden';
      sub.battler.hideBubble();
      sub.battler.startPoofOut();
    }
    if (pb.wave !== 'idle') {
      bumpCounter('battlesResolved');
      pb.wave = 'idle';
      pb.waveRing = [];
      pb.currentAttack = null;
      pb.parentWalker.setForcedBackView(false);
      this.revertMega(pb);
      this.nextBattleEarliestAt = Date.now() + this.randomCooldown();
      this.deps.onBattleEnd(parentId);
      notifyBattleEnd(parentId);
    }
  }

  // --- species selection -------------------------------------------------

  private collectExcludedLines(): Set<string> {
    const set = new Set(this.deps.activeSessionLines());
    for (const pb of this.battles.values()) {
      for (const sub of pb.subs) set.add(sub.battler.species.line);
    }
    return set;
  }

  /** Random ANIMATED species (every DEX entry has sprite art — bundled or
   *  lazily fetched), excluding lines already active as sessions or other
   *  battlers, preferring bundled (instant, no network) base forms first. */
  private pickSpecies(): DexEntry | null {
    const excluded = this.collectExcludedLines();
    const pools: DexEntry[][] = [
      DEX_LIST.filter((e) => e.hasSprite && isBundled(e.id) && e.stage === 1 && !excluded.has(e.line)),
      DEX_LIST.filter((e) => e.hasSprite && isBundled(e.id) && !excluded.has(e.line)),
      DEX_LIST.filter((e) => e.hasSprite && e.stage === 1 && !excluded.has(e.line)),
      DEX_LIST.filter((e) => e.hasSprite && !excluded.has(e.line)),
      DEX_LIST.filter((e) => e.hasSprite)
    ];
    for (const pool of pools) {
      if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
    }
    return null;
  }

  // --- battle lifecycle ----------------------------------------------------

  private createBattle(parentId: string, parentWalker: Walker): ParentBattle {
    return {
      parentId,
      parentWalker,
      subs: [],
      waveRing: [],
      wave: 'idle',
      waveElapsedMs: 0,
      waveAttacks: 0,
      alertShown: false,
      currentAttack: null,
      lastAttackerWasParent: false,
      roundRobinIdx: 0,
      parentStandTile: null,
      pendingTool: null,
      pendingCombo: 0,
      nextSeq: 0,
      waveStartedAt: 0,
      waveStuckCapMs: WAVE_STUCK_MIN_MS,
      megaActive: false
    };
  }

  private randomCooldown(): number {
    return BATTLE_COOLDOWN_MIN_MS + Math.random() * (BATTLE_COOLDOWN_MAX_MS - BATTLE_COOLDOWN_MIN_MS);
  }

  /** The globally-oldest `queued` sub across every parent — the cross-parent
   *  FIFO tie-break that makes the battle queue global rather than
   *  per-parent (spec: "no overlapping or instantly-chained fights, ever —
   *  including across different parent sessions"). Null if nothing is
   *  queued anywhere. */
  private pickNextQueued(): { pb: ParentBattle; sub: SubBattler } | null {
    let best: { pb: ParentBattle; sub: SubBattler } | null = null;
    for (const pb of this.battles.values()) {
      for (const sub of pb.subs) {
        if (sub.lifecycle !== 'queued') continue;
        if (!best || sub.queuedSince < best.sub.queuedSince) best = { pb, sub };
      }
    }
    return best;
  }

  /** Admit exactly one queued sub into a fresh wave — called only when the
   *  global lock (`update`) says no other parent is mid-wave and the
   *  cooldown gap has elapsed. */
  private admitBattle(pb: ParentBattle, sub: SubBattler): void {
    // Always length 1 today (MAX_RING) — kept as a real array (not a bare
    // field) so pickChallengerStandTileFor/gapTilesForBatch's existing
    // slot-based machinery needs no signature change.
    const admitted = [sub].slice(0, MAX_RING);
    for (const s of admitted) s.lifecycle = 'battling';
    for (const s of admitted) s.battler.showBubbleLabel();
    pb.waveRing = admitted;
    pb.wave = 'alert';
    bumpCounter('battlesStarted');
    pb.waveElapsedMs = 0;
    pb.waveStartedAt = Date.now();
    pb.waveAttacks = 0;
    pb.alertShown = false;
    pb.currentAttack = null;
    pb.roundRobinIdx = 0;
    pb.lastAttackerWasParent = false;
    pb.pendingTool = null;
    pb.pendingCombo = 0;

    // Freeze the parent exactly where it is for the "!" alert beat —
    // goTo(its own tile) is a zero-length path (see pathfinding.ts) that
    // stops any in-flight wander without moving it. The real approach walk
    // (to parentStandTile) is issued once the alert finishes.
    pb.parentWalker.goTo(pb.parentWalker.tile);

    // A fresh stand tile every wave — the parent may have moved during the
    // last roaming gap.
    const gap = this.gapTilesForBatch(pb.parentId, admitted);
    const originalTile = pb.parentWalker.tile;
    pb.parentStandTile = this.findMeetingAnchor(originalTile, gap) ?? originalTile;

    const anchor = pb.parentStandTile;
    admitted.forEach((s, slot) => {
      s.battler.standTile = this.pickChallengerStandTileFor(admitted, gap, slot, anchor);
    });

    // Distance-based stuck watchdog for THIS wave's alert/approaching phases
    // (see WAVE_STUCK_MIN_MS's own comment) — a roaming challenger can be
    // anywhere on the map, unlike the old fixed-radius spawn, so the cap has
    // to scale with the actual walk rather than stay a flat constant. `* 3`
    // is slack for BFS detours around obstacles, not a straight-line
    // guarantee.
    const walkTiles = Math.max(
      manhattan(sub.battler.tile, sub.battler.standTile ?? sub.battler.tile),
      manhattan(originalTile, anchor)
    );
    const msPerTile = (this.deps.map.tileSize / BATTLER_SPEED_PX_S) * 1000;
    pb.waveStuckCapMs = Math.max(WAVE_STUCK_MIN_MS, walkTiles * msPerTile * 3);

    notifyBattleStart(pb.parentId); // crossfades ambient -> battle music (no-op if already battling elsewhere)
    // Cache-warming only, not the real trigger — see startMega's own doc
    // comment for why this needs a head start over the alert+approach walk.
    this.startMega(pb, true);
  }

  /** A far corner of the map, well apart from any sibling already roaming
   *  there — the farthest corner from the parent's CURRENT position, with
   *  local jitter/avoidance spreading multiple roamers out instead of
   *  stacking on the same tile. `reachableFrom` (the parent's tile — no
   *  battler exists yet at spawn time to BFS from) keeps the pick off a
   *  disconnected pocket (the far side of a wall/pond), which would leave
   *  this battler unable to ever walk back for its eventual completion
   *  battle. Falls back toward the parent only in the pathological case
   *  where nowhere far is reachable at all. */
  private pickRoamHome(pb: ParentBattle, reachableFrom: { x: number; y: number }): { x: number; y: number } {
    const map = this.deps.map;
    const margin = CORNER_MARGIN;
    const corners = [
      { x: margin, y: margin },
      { x: map.width - 1 - margin, y: margin },
      { x: margin, y: map.height - 1 - margin },
      { x: map.width - 1 - margin, y: map.height - 1 - margin }
    ];
    const parentTile = pb.parentWalker.tile;
    corners.sort((a, b) => manhattan(b, parentTile) - manhattan(a, parentTile));

    const claimed = new Set<string>();
    for (const sub of pb.subs) {
      if (sub.lifecycle === 'roaming') claimed.add(tileKey(sub.wanderHome));
    }

    for (const corner of corners) {
      const home =
        findNearbyWalkable(map, corner, 0, 6, claimed, reachableFrom) ??
        findNearbyWalkable(map, corner, 0, 14, claimed, reachableFrom);
      if (home) return home;
    }
    return parentTile; // pathological: nothing reachable anywhere far — stand near the parent instead
  }

  /** Face-off gap, in tiles, for this wave — bumped up whenever the parent or
   *  any admitted battler is a large-class sprite so a Snorlax or Tyranitar
   *  never reads as standing inside its opponent. */
  private gapTilesForBatch(parentId: string, subs: SubBattler[]): number {
    const map = this.deps.map;
    const parentSpeciesId = this.deps.getParentSpeciesId(parentId);
    const parentAnimation = parentSpeciesId ? this.deps.resolveAnimation(parentSpeciesId) : undefined;
    const parentPixels = parentAnimation
      ? targetTileHeight(parentAnimation.info.name, parentAnimation.front.frameHeight) * map.tileSize
      : GAP_BASE_TILES * map.tileSize;
    const maxPixels = subs.reduce((m, s) => Math.max(m, s.battler.drawnHeight), parentPixels);
    const isLarge = maxPixels >= LARGE_TILE_THRESHOLD * map.tileSize;
    return GAP_BASE_TILES + (isLarge ? GAP_LARGE_BONUS_TILES : 0);
  }

  /**
   * The parent's stand tile for THIS wave — the bottom-left half of a
   * canonical bottom-left(parent)/top-right(challenger) battle pair. Tries
   * the parent's own current tile first (it may not need to move at all); if
   * that tile has no valid NE partner (or the partner isn't actually
   * reachable from it), widens a shuffled search outward from `originalTile`
   * for an alternate anchor that DOES have one — moving the whole meeting
   * spot to open lawn rather than ever inverting the arrangement. `gap` is
   * the eventual parent-challenger distance on each axis; the anchor only
   * needs its immediate NE corner to be clear, since
   * pickChallengerStandTileFor does its own reachability search from here
   * for the actual stand tile.
   */
  private findMeetingAnchor(originalTile: { x: number; y: number }, gap: number): { x: number; y: number } | null {
    const hasNePartner = (a: { x: number; y: number }): boolean => {
      if (!this.deps.map.isWalkable(a.x, a.y)) return false;
      const partner = { x: a.x + gap, y: a.y - gap };
      if (!this.deps.map.isWalkable(partner.x, partner.y)) return false;
      return findPath(this.deps.map, a, partner) !== null;
    };
    const reachableFromOriginal = (a: { x: number; y: number }): boolean =>
      (a.x === originalTile.x && a.y === originalTile.y) || findPath(this.deps.map, originalTile, a) !== null;

    if (hasNePartner(originalTile)) return originalTile;

    for (let radius = 1; radius <= 12; radius++) {
      const ring: { x: number; y: number }[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        const dy = radius - Math.abs(dx);
        ring.push({ x: originalTile.x + dx, y: originalTile.y + dy });
        if (dy !== 0) ring.push({ x: originalTile.x + dx, y: originalTile.y - dy });
      }
      for (let i = ring.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ring[i], ring[j]] = [ring[j], ring[i]];
      }
      for (const c of ring) {
        if (hasNePartner(c) && reachableFromOriginal(c)) return c;
      }
    }
    return null;
  }

  /**
   * A stand tile for ring slot `slot`, ALWAYS somewhere in the top/right arc
   * from `anchor` (the parent's stand tile for this wave) — never level with
   * it, never on its bottom/left side. This is what lets `applyBattleStance`
   * skip all direction math: an unmirrored front sheet drawn facing
   * down-left already points at anything placed up-right of it. Up to
   * MAX_RING slots fan across the arc (roughly NE, ENE, NNE) at the same
   * radius so they spread out rather than stacking. Every candidate is
   * BFS-reachable from `anchor` — not just "walkable" — so goTo() is
   * guaranteed to actually get there (no permanently-stuck battler).
   */
  private pickChallengerStandTileFor(
    admitted: SubBattler[],
    gap: number,
    slot: number,
    anchor: { x: number; y: number }
  ): { x: number; y: number } {
    const claimed = new Set<string>([tileKey(anchor)]);
    for (const s of admitted) if (s.battler.standTile) claimed.add(tileKey(s.battler.standTile));

    const arcOffsets = [
      { x: gap, y: -gap },
      { x: Math.round(gap * 1.4), y: -Math.round(gap * 0.6) },
      { x: Math.round(gap * 0.6), y: -Math.round(gap * 1.4) }
    ];
    const primary = arcOffsets[slot % arcOffsets.length];
    const primaryTile = { x: anchor.x + primary.x, y: anchor.y + primary.y };
    if (
      !claimed.has(tileKey(primaryTile)) &&
      this.deps.map.isWalkable(primaryTile.x, primaryTile.y) &&
      findPath(this.deps.map, anchor, primaryTile) !== null
    ) {
      return primaryTile;
    }

    // Widen the search but STAY in the NE quadrant relative to the PARENT's
    // anchor (never the search center) — never fall back to its bottom/left
    // side.
    return (
      findNearbyWalkable(
        this.deps.map,
        primaryTile,
        1,
        gap + 3,
        claimed,
        anchor,
        (c) => c.x >= anchor.x && c.y <= anchor.y
      ) ?? primaryTile
    );
  }

  /**
   * The fixed battle stance — NO mirroring math, ever. The parent (always at
   * the bottom-left of the pair) shows its BACK sheet UNMIRRORED, which
   * gen5ani draws already aimed up-right at whatever's in the top/right arc.
   * Every ring member (always somewhere in that arc) shows its FRONT sheet
   * UNMIRRORED, which gen5ani draws already aimed down-left at the parent.
   */
  /** The fixed battle stance, re-derived and re-applied EVERY TICK the wave
   *  is 'faceoff'/'looping' (see `update`'s own call to this, below the
   *  phase switch) — not just once at the transition into 'faceoff' — so a
   *  lunge or an evolution mid-battle can never leave the mirroring stale.
   *  `setForcedBackView`/`faceDirection` are cheap no-ops when already
   *  correct, which is what makes calling this every frame safe; `startMega`
   *  is NOT idempotent the same way (an async fetch, a floating-text spawn),
   *  so it is deliberately called once, at the ONE-TIME transition site
   *  (`updateApproaching`), not from here. */
  private applyBattleStance(pb: ParentBattle): void {
    pb.parentWalker.setForcedBackView(true);
    pb.parentWalker.faceDirection('left'); // native/unmirrored
    for (const sub of pb.waveRing) sub.battler.setBattleStance();
  }

  /** Mega evolution, battle-only (design: no picker entry, no manual toggle,
   *  no work-based trigger). Two call sites, same method:
   *
   *  1. `admitBattle` (`prefetchOnly: true`), the instant a wave is admitted
   *     — a queued battler isn't fighting yet, but the parent IS already
   *     committed to this exact fight (`battlesStarted` bumps right there),
   *     so kicking the fetch off here rather than waiting for `faceoff`
   *     gives it the whole alert-bubble + cross-map approach walk as a head
   *     start. A cold-cache gen5ani GIF (network + LZW decode + per-frame
   *     canvas coalesce over 50-180 frames) can plausibly take longer than
   *     `FACEOFF_MS` + a couple of attacks combined, so without this the
   *     mega would frequently resolve after the fight already ended, land
   *     in the discard branch below, and silently never show — a `prefetch`
   *     call never applies anything itself (see the early return), it only
   *     warms `loadView`'s own cache (lazySprites.ts) for #2.
   *  2. `updateApproaching`, the ONE spot a wave transitions into 'faceoff'
   *     — the real, apply-attempting call. By now #1's fetch is very likely
   *     already resolved (or resolves within a tick or two, off the SAME
   *     cached promise), so this reads as effectively instant. Unlike
   *     `applyBattleStance` (re-applied every tick for facing upkeep —
   *     cheap idempotent no-ops), this fires exactly once: `updateApproaching`
   *     only ever sets `wave = 'faceoff'` the one time it does.
   *
   *  No-op for the ~980 species with no mega form (the common case) and
   *  while the parent is mid-evolution-ceremony (file header invariant:
   *  never touch a walker's sprite while `isEvolving`). */
  private startMega(pb: ParentBattle, prefetchOnly = false): void {
    if (pb.parentWalker.isEvolving) return;
    const speciesId = this.deps.getParentSpeciesId(pb.parentId);
    if (!speciesId) return;
    const megaId = pickMegaId(speciesId, `${pb.parentId}:${pb.waveStartedAt}`);
    if (!megaId) return; // no mega form for this species
    const shiny = this.deps.getParentShiny(pb.parentId);
    const promise = loadMegaAnimation(speciesId, megaId, shiny);
    if (prefetchOnly) {
      void promise; // fire-and-forget — cache-warming only, see doc comment above
      return;
    }
    const token = pb.waveStartedAt;
    void promise.then((anim) => {
      // Stale if: this exact wave already has a mega applied (belt-and-
      // braces — the split above means only #2 ever reaches here, but this
      // costs nothing to keep), a later wave has since started for this
      // same parent (token mismatch), this exact wave has moved past the
      // actual fighting phase (faceoff/looping) — including into 'ending',
      // the victory beat, where a fetch resolving now would visibly
      // mega-evolve the parent AFTER the fight already reads as over, only
      // to revert moments later — or evolution started meanwhile. Discard
      // rather than apply.
      if (pb.megaActive) return;
      if (pb.waveStartedAt !== token) return;
      if (pb.wave !== 'faceoff' && pb.wave !== 'looping') return;
      if (pb.parentWalker.isEvolving) return;
      if (!anim) {
        safeLogDiagnostic('battle', 'warn', 'mega evolve failed — sprite unavailable', { speciesId, megaId, shiny });
        return;
      }
      pb.megaActive = true;
      pb.parentWalker.setTemporaryForm(anim);
      pb.parentWalker.showFloatingText(`${this.deps.getParentLabel(pb.parentId)} Mega Evolved!`);
      safeLogDiagnostic('battle', 'info', 'mega evolve started', { speciesId, megaId, shiny });
    });
  }

  /** The other half of startMega — reverts the parent's sprite to whatever
   *  it was before the mega swap. Safe (and cheap) to call unconditionally
   *  at every battle-end/teardown site: a no-op when no mega is active
   *  (`megaActive` false, the common case), and `Walker.setTemporaryForm`
   *  itself is idempotent on top of that (nothing to revert to if evolution
   *  already superseded the base mid-battle — see that method's own doc). */
  private revertMega(pb: ParentBattle): void {
    if (!pb.megaActive) return;
    pb.megaActive = false;
    pb.parentWalker.setTemporaryForm(null);
  }

  /** The "trainer spotted you" beat: once the (first) ring member has
   *  actually finished poofing in — a bubble over something still fading in
   *  reads wrong — pop a "!" over both it and the parent, simultaneously,
   *  and hold the wave in place until the parent's bubble finishes its pop
   *  in/hold/pop-out cycle. Only then does anyone actually start walking
   *  (see the callback). */
  private updateAlert(pb: ParentBattle): void {
    if (pb.alertShown) return;
    const first = pb.waveRing[0];
    if (!first || first.battler.isSpawning) return;
    pb.alertShown = true;
    spawnExclaimBubble(pb.parentWalker.container, -pb.parentWalker.spriteHeight - 8, () => {
      pb.wave = 'approaching';
      pb.waveElapsedMs = 0;
      pb.parentWalker.goTo(pb.parentStandTile ?? pb.parentWalker.tile);
      for (const sub of pb.waveRing) if (sub.battler.standTile) sub.battler.goTo(sub.battler.standTile);
    });
    for (const sub of pb.waveRing) spawnExclaimBubble(sub.battler.container, -sub.battler.drawnHeight - 6);
  }

  private updateApproaching(pb: ParentBattle): void {
    if (pb.waveRing.length === 0) return;
    const allArrived = pb.waveRing.every((s) => s.battler.arrived);
    const parentTile = pb.parentWalker.tile;
    const parentArrived =
      !pb.parentStandTile || (parentTile.x === pb.parentStandTile.x && parentTile.y === pb.parentStandTile.y);
    if (!allArrived || !parentArrived) return;
    pb.wave = 'faceoff';
    pb.waveElapsedMs = 0;
    this.applyBattleStance(pb);
    this.startMega(pb);
  }

  private updateFaceoff(pb: ParentBattle, dt: number): void {
    pb.waveElapsedMs += dt * 1000;
    if (pb.waveElapsedMs >= FACEOFF_MS) {
      pb.wave = 'looping';
      pb.waveElapsedMs = 0;
      this.startAttack(pb, pb.pendingTool ?? 'Task');
      if (pb.currentAttack && pb.pendingTool) pb.currentAttack.combo = pb.pendingCombo;
      pb.pendingTool = null;
      pb.pendingCombo = 0;
    }
  }

  private startAttack(pb: ParentBattle, tool: string): void {
    if (pb.waveRing.length === 0) return;
    const attackerIsParent = !pb.lastAttackerWasParent;
    pb.lastAttackerWasParent = attackerIsParent;
    const idx = pb.roundRobinIdx % pb.waveRing.length;
    pb.roundRobinIdx++;
    const target = pb.waveRing[idx];
    pb.currentAttack = {
      attacker: attackerIsParent ? 'parent' : target,
      defender: attackerIsParent ? target : 'parent',
      tool,
      combo: 1,
      elapsedMs: 0,
      hitApplied: false
    };
    // Give the beat an immediate visual even when the hook signal that
    // supplies a more specific tool name arrives a frame later. The signal
    // handler replaces this with the observed tool when it arrives.
    for (const sub of pb.waveRing) sub.battler.showAttack(tool);
  }

  private advanceAttack(pb: ParentBattle, dt: number): void {
    const a = pb.currentAttack;
    if (!a) return;
    a.elapsedMs += dt * 1000;
    if (!a.hitApplied && a.elapsedMs >= LUNGE_MS) {
      a.hitApplied = true;
      this.applyHit(pb, a);
    }
    if (a.elapsedMs < ATTACK_TOTAL_MS) return;

    pb.currentAttack = null;
    for (const sub of pb.waveRing) sub.battler.showBubbleLabel();
    pb.waveAttacks++;
    if (pb.waveAttacks < WAVE_ATTACKS) {
      this.startAttack(pb, 'Task');
    } else {
      this.beginEnding(pb);
    }
  }

  private applyHit(pb: ParentBattle, a: Attack): void {
    const attackerLabel =
      a.attacker === 'parent' ? this.deps.getParentLabel(pb.parentId) : a.attacker.battler.species.name;
    const comboSuffix = a.combo > 1 ? ` ×${a.combo}` : '';
    const text = `${attackerLabel} used ${a.tool}!${comboSuffix}`;

    if (a.attacker === 'parent') pb.parentWalker.showFloatingText(text);
    else a.attacker.battler.showMoveText(text);

    const defenderContainer = a.defender === 'parent' ? pb.parentWalker.container : a.defender.battler.container;
    const defenderHeight = a.defender === 'parent' ? pb.parentWalker.spriteHeight : a.defender.battler.drawnHeight;
    spawnHitFlash(defenderContainer, Math.max(16, defenderHeight * 0.7), defenderHeight);
    playAttackSound(a.tool); // one sound per rendered lunge — applyHit already respects combo coalescing
  }

  private applyPositions(pb: ParentBattle): void {
    const parentContainer = pb.parentWalker.container;
    parentContainer.x = Math.round(pb.parentWalker.worldX);
    parentContainer.y = Math.round(pb.parentWalker.worldY);

    if (pb.wave === 'ending') {
      const t = Math.min(1, pb.waveElapsedMs / ENDING_MS);
      parentContainer.y -= Math.round(Math.sin(t * Math.PI) * 8);
      return;
    }

    const a = pb.currentAttack;
    if (!a) return;

    let progress: number;
    if (a.elapsedMs < LUNGE_MS) progress = a.elapsedMs / LUNGE_MS;
    else if (a.elapsedMs < LUNGE_MS + HOLD_MS) progress = 1;
    else progress = Math.max(0, 1 - (a.elapsedMs - LUNGE_MS - HOLD_MS) / RETURN_MS);

    const attackerContainer = a.attacker === 'parent' ? parentContainer : a.attacker.battler.container;
    const defenderContainer = a.defender === 'parent' ? parentContainer : a.defender.battler.container;
    // A fixed FRACTION of the actual gap, not a fixed pixel distance: it
    // scales with however far apart pickChallengerStandTileFor put these
    // two, so the lunge always stops well short of the opponent's body
    // regardless of sprite size or map layout.
    const dx = defenderContainer.x - attackerContainer.x;
    const dy = defenderContainer.y - attackerContainer.y;
    attackerContainer.x += Math.round(dx * LUNGE_FRACTION * progress);
    attackerContainer.y += Math.round(dy * LUNGE_FRACTION * progress);

    if (a.hitApplied) {
      const shakeT = (a.elapsedMs - LUNGE_MS) / SHAKE_MS;
      if (shakeT >= 0 && shakeT < 1) {
        const s = (1 - shakeT) * 3;
        defenderContainer.x += Math.round((Math.random() - 0.5) * 2 * s);
        defenderContainer.y += Math.round((Math.random() - 0.5) * 2 * s);
      }
    }
  }

  private beginEnding(pb: ParentBattle): void {
    pb.wave = 'ending';
    pb.waveElapsedMs = 0;
    pb.currentAttack = null;
    for (const sub of pb.waveRing) sub.battler.showBubbleLabel();
    pb.parentWalker.setForcedBackView(false);
    this.revertMega(pb);
    // No dedicated victory/celebration SPRITE ANIMATION exists to play here —
    // confirmed against the actual sprite pipeline (see file header). This
    // floating text + sparkle burst + chime is overlay FX, not a sprite
    // swap, so it stands in for that as the (non-fabricated) celebration.
    pb.parentWalker.showFloatingText('Victory!');
    spawnSparkleBurst(pb.parentWalker.container);
    playVictoryChime();
  }

  private updateEnding(pb: ParentBattle, dt: number): void {
    pb.waveElapsedMs += dt * 1000;
    if (pb.waveElapsedMs >= ENDING_MS) this.concludeWave(pb);
  }

  /** The wave is over — its one challenger loses and, since the done/retired
   *  follow-up, goes `'retired'` rather than poofing away for good (see
   *  `retireSub`). Frees the global lock for the next queued battle (after
   *  the cooldown gap) and lets the parent resume its own life. */
  private concludeWave(pb: ParentBattle): void {
    for (const sub of pb.waveRing) {
      if (sub.lifecycle !== 'battling') continue;
      this.retireSub(sub);
    }
    pb.waveRing = [];
    pb.wave = 'idle';
    bumpCounter('battlesResolved');
    pb.parentWalker.setForcedBackView(false);
    this.revertMega(pb);
    this.nextBattleEarliestAt = Date.now() + this.randomCooldown();
    this.deps.onBattleEnd(pb.parentId);
    notifyBattleEnd(pb.parentId); // crossfades back to ambient once this was the last active wave anywhere
  }

  /** Defensive equivalent of `concludeWave` for a wave that's stuck or whose
   *  processing just threw (see `update`'s per-parent try/catch and the hard
   *  cap in `updateOneBattle`) — same end state (the challenger retires
   *  off-duty, the parent's stance releases, the global lock frees) but
   *  doesn't assume anything about the wave's current phase or the
   *  battler's internal state, since this runs from contexts where either
   *  could be corrupted. */
  private forceConcludeWave(pb: ParentBattle): void {
    for (const sub of pb.waveRing) {
      if (sub.lifecycle !== 'battling') continue;
      try {
        this.retireSub(sub);
      } catch {
        /* best-effort — the battler itself may be what's corrupted */
      }
    }
    pb.waveRing = [];
    if (pb.wave !== 'idle') bumpCounter('battlesResolved');
    pb.wave = 'idle';
    pb.currentAttack = null;
    try {
      pb.parentWalker.setForcedBackView(false);
      this.revertMega(pb);
    } catch {
      /* best-effort */
    }
    this.nextBattleEarliestAt = Date.now() + this.randomCooldown();
    try {
      this.deps.onBattleEnd(pb.parentId);
    } catch {
      /* best-effort */
    }
    try {
      notifyBattleEnd(pb.parentId);
    } catch {
      /* best-effort */
    }
  }

  /** Losing a completion battle no longer poofs a sub away for good (user-
   *  approved change, 2026-08-29) — it goes `'retired'`: tinted with the
   *  opaque, hue-neutral `RETIRED_TINT` (cheap, subtle, reads as "off duty"
   *  at pixel scale without a second sprite/tint pass), sent walking back
   *  toward its own
   *  `wanderHome` (best-effort — `goTo` silently no-ops if that's
   *  unreachable from wherever the battle left it, same latitude every
   *  other roam call in this file already takes), and handed to
   *  `updateRoaming` from here on (see `updateOneBattle`'s sub loop) with no
   *  further queue-eligibility checks ever applying to it again. Stays in
   *  `pb.subs` — and therefore on the roster strip — until `despawnBattler`
   *  removes it. */
  private retireSub(sub: SubBattler): void {
    sub.lifecycle = 'retired';
    sub.toolBubbleRemainingMs = 0;
    sub.roamBubbleMode = 'hidden';
    sub.battler.hideBubble();
    sub.battler.container.tint = RETIRED_TINT;
    sub.wanderTimer = 0;
    sub.wanderDelay = WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY);
    sub.battler.goTo(sub.wanderHome);
    this.deps.onBattlerDone(sub.key, true);
  }

  /** The other half of `retireSub` — a resumed task-id whose battler is
   *  still sitting `'retired'` (done, on the map, not yet despawned) is
   *  revived in place instead of `handleCorrelate`'s RESUME branch spawning
   *  a duplicate. Back to `'roaming'`, full opacity, a fresh `roamingSince`
   *  (so MAX_ROAM_MS/MIN_ROAM_MS clock this run's OWN roam, not however long
   *  it already sat retired). Deliberately leaves the store's `spawnedAt`
   *  alone (that's `setBattlerDone`/`addBattler`'s concern, not this one) —
   *  this is the same battler picking its work back up, not a fresh spawn,
   *  so its roster card keeps counting from its original spawn once
   *  `setBattlerDone(key, false)` clears `doneAt`. */
  private reviveRetired(sub: SubBattler): void {
    sub.lifecycle = 'roaming';
    sub.battler.container.tint = 0xffffff;
    const bubbleTiming = roamingBubbleTiming(sub.key);
    sub.roamLabelElapsedMs = bubbleTiming.elapsedMs;
    sub.roamLabelCycleMs = bubbleTiming.cycleMs;
    sub.toolBubbleRemainingMs = 0;
    sub.roamBubbleMode = 'hidden';
    sub.roamingSince = Date.now();
    sub.queueEligibleAt = null;
    sub.queuedSince = 0;
    this.deps.onBattlerDone(sub.key, false);
  }

  /** Explicit player action (SubagentRosterCard's despawn button, offered
   *  only for a `done` battler): plays the pokéball-recall animation
   *  (`Battler.startRecall`/battleFx.ts's `spawnPokeballRecall`) and only
   *  THEN does the same terminal bookkeeping `reapSubs`/`destroyBattle`
   *  elsewhere in this file do (`subagentsCleanedUp`, `onBattlerRemoved`) —
   *  driven by the recall's own completion callback rather than
   *  `isPoofedOut`, since this is its own animation on its own clock, not
   *  `startPoofOut`'s. A no-op if this battler is already mid-recall
   *  (double-click guard) or no longer exists (already gone). If a parent
   *  teardown (`forceEnd`/`dispose`) reaches this sub before the recall
   *  finishes, `destroyBattle` sweeps it up unconditionally regardless of
   *  lifecycle — this callback then simply never fires, no double-remove.
   *  The callback below calls `sub.battler.destroy()` from INSIDE an FX tick
   *  (it's `spawnPokeballRecall`'s own `onDone`, invoked by `tickBattleFx`'s
   *  loop) — safe: `destroy()` -> `purgeBattleFxFor` reassigns battleFx.ts's
   *  `active` array, but `tickBattleFx`'s own `for...of` is iterating the
   *  ORIGINAL array reference and only commits `active = next` once that
   *  loop finishes, so the reassignment mid-iteration is simply superseded;
   *  any other FX still registered against this now-destroyed container
   *  (there shouldn't be one, but if there were) gets dropped next frame via
   *  that loop's own `entry.owner.destroyed` guard either way. */
  despawnBattler(key: string): void {
    for (const pb of this.battles.values()) {
      const sub = pb.subs.find((s) => s.key === key);
      if (!sub) continue;
      if (sub.lifecycle === 'despawning') return;
      sub.lifecycle = 'despawning';
      sub.battler.startRecall(() => {
        pb.subs = pb.subs.filter((s) => s !== sub);
        sub.battler.destroy();
        bumpCounter('subagentsCleanedUp');
        this.deps.onBattlerRemoved(sub.key);
      });
      return;
    }
  }

  /** Periodic local roam around `sub`'s home tile — mirrors Walker.ts's own
   *  idle wander (updateWander) exactly, just against a Battler instead of a
   *  Walker. */
  private updateRoaming(sub: SubBattler, dt: number): void {
    this.updateRoamingBubble(sub, dt);
    sub.wanderTimer += dt;
    if (sub.wanderTimer < sub.wanderDelay) return;
    sub.wanderTimer = 0;
    sub.wanderDelay = WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY);

    const cur = sub.battler.tile;
    for (let attempt = 0; attempt < 16; attempt++) {
      const tx = sub.wanderHome.x + Math.floor(Math.random() * WANDER_RANGE * 2) - WANDER_RANGE;
      const ty = sub.wanderHome.y + Math.floor(Math.random() * WANDER_RANGE * 2) - WANDER_RANGE;
      if (tx === cur.x && ty === cur.y) continue;
      if (!this.deps.map.isWalkable(tx, ty)) continue;
      if (sub.battler.goTo({ x: tx, y: ty })) return;
    }
  }

  /** Drive Tier 1's intermittent label cadence and let a freshly observed
   *  Tier 2 tool bubble take over until its short display window expires. */
  private updateRoamingBubble(sub: SubBattler, dt: number): void {
    sub.roamLabelElapsedMs = (sub.roamLabelElapsedMs + dt * 1000) % sub.roamLabelCycleMs;
    if (sub.toolBubbleRemainingMs > 0) {
      sub.toolBubbleRemainingMs = Math.max(0, sub.toolBubbleRemainingMs - dt * 1000);
      if (sub.toolBubbleRemainingMs > 0) return;
    }

    const shouldShowLabel = !!sub.label && sub.roamLabelElapsedMs < ROAM_LABEL_VISIBLE_MS;
    const nextMode: SubBattler['roamBubbleMode'] = shouldShowLabel ? 'label' : 'hidden';
    if (nextMode === sub.roamBubbleMode) return;
    sub.roamBubbleMode = nextMode;
    if (nextMode === 'label') sub.battler.showBubbleLabel();
    else sub.battler.hideBubble();
  }

  // Only ever reaps 'leaving' subs (handleEndAll's own poof path) —
  // 'retired' stays here on purpose until despawned, and 'despawning'
  // removes itself via its own recall-completion callback (despawnBattler),
  // not this poll.
  private reapSubs(pb: ParentBattle): void {
    if (!pb.subs.some((s) => s.lifecycle === 'leaving' && s.battler.isPoofedOut)) return;
    pb.subs = pb.subs.filter((sub) => {
      if (sub.lifecycle !== 'leaving' || !sub.battler.isPoofedOut) return true;
      sub.battler.destroy();
      bumpCounter('subagentsCleanedUp');
      this.deps.onBattlerRemoved(sub.key);
      return false;
    });
  }

  /** Hard teardown (forceEnd/dispose) — every remaining sub is destroyed
   *  with no poof ceremony, so each one counts as cleaned up right here
   *  rather than through reapSubs, which this bypasses entirely. */
  private destroyBattle(pb: ParentBattle): void {
    for (const sub of pb.subs) {
      sub.battler.destroy();
      bumpCounter('subagentsCleanedUp');
      this.deps.onBattlerRemoved(sub.key);
    }
    pb.parentWalker.setForcedBackView(false);
    this.revertMega(pb);
  }
}
