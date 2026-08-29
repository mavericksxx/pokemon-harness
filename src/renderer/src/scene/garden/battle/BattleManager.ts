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
 * trigger for `handleEnd`'s "queue the oldest roaming sub" heuristic —
 * `SubagentStop` (`handleEnd`'s other caller, hookRouter.ts) is still wired
 * but no longer forwards into a battle signal, specifically to avoid
 * double-firing 'end' for one real completion (which would prematurely
 * conclude an unrelated, still-working sibling). This still matches publicly
 * tracked upstream issues (e.g. anthropics/claude-code #25147, #27755,
 * #33049 — background/subagent completion signals unreliable) in spirit:
 * real, but not safe to build load-bearing per-subagent identity on.
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
import { notifyBattleStart, notifyBattleEnd, playAttackSound, playVictoryChime } from '@/audio/audioEngine';
import { bumpCounter } from '@/diagnosticsCounters';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { hasPendingAsyncSubagents } from '@/pty/hookRouter';

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
  lifecycle: 'roaming' | 'queued' | 'battling' | 'leaving';
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
}

function tileKey(t: { x: number; y: number }): string {
  return `${t.x},${t.y}`;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
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
    for (const sub of pb.subs) sub.battler.container.visible = visible;
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
      for (const sub of pb.subs) sub.battler.update(dt);
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
        }
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

    if (pb.subs.length === 0 && pb.wave === 'idle') finishedParents.push(pb.parentId);
  }

  // --- signal handling -------------------------------------------------

  private onSignal(sig: BattleSignal): void {
    switch (sig.type) {
      case 'spawn':
        this.handleSpawn(sig.parentId, sig.label);
        break;
      case 'attack':
        this.handleAttack(sig.parentId, sig.tool);
        break;
      case 'end':
        this.handleEnd(sig.parentId);
        break;
      case 'endAll':
        this.handleEndAll(sig.parentId);
        break;
      case 'parentDone':
        this.handleParentDone(sig.parentId);
        break;
    }
  }

  private handleSpawn(parentId: string, label?: string): void {
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
    const battler = new Battler({ map: this.deps.map, animation, species, spawnTile: home });
    this.deps.charLayer.addChild(battler.container);

    const sub: SubBattler = {
      key: `${parentId}#${pb.nextSeq++}`,
      battler,
      lifecycle: 'roaming',
      wanderHome: home,
      wanderTimer: 0,
      wanderDelay: WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY),
      roamingSince: Date.now(),
      queuedSince: 0,
      queueEligibleAt: null,
      visibleLogged: false
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

  /** SubagentStop, when it actually arrives (see file header — unreliable,
   *  used opportunistically). No per-subagent id survives to this point, so
   *  this queues the OLDEST currently-roaming subagent for the parent — the
   *  best available guess, same "no real correlation, do something
   *  reasonable" position the regex-fallback path (`endAll`) is already in.
   *  Bypasses `MIN_ROAM_MS` — this signal names one specific subagent's real
   *  completion, not a coarse per-turn proxy, so there's nothing to guard
   *  against. */
  private handleEnd(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    let oldest: SubBattler | null = null;
    for (const sub of pb.subs) {
      if (sub.lifecycle !== 'roaming') continue;
      if (!oldest || sub.roamingSince < oldest.roamingSince) oldest = sub;
    }
    if (oldest) this.queueForBattle(oldest);
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
   *  extend. */
  private handleEndAll(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    for (const sub of pb.subs) {
      if (sub.lifecycle === 'leaving') continue;
      sub.lifecycle = 'leaving';
      sub.battler.startPoofOut();
    }
    if (pb.wave !== 'idle') {
      bumpCounter('battlesResolved');
      pb.wave = 'idle';
      pb.waveRing = [];
      pb.currentAttack = null;
      pb.parentWalker.setForcedBackView(false);
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
      waveStuckCapMs: WAVE_STUCK_MIN_MS
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
  private applyBattleStance(pb: ParentBattle): void {
    pb.parentWalker.setForcedBackView(true);
    pb.parentWalker.faceDirection('left'); // native/unmirrored
    for (const sub of pb.waveRing) sub.battler.setBattleStance();
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
    pb.parentWalker.setForcedBackView(false);
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

  /** The wave is over — its one challenger loses and poofs away for good.
   *  Frees the global lock for the next queued battle (after the cooldown
   *  gap) and lets the parent resume its own life. */
  private concludeWave(pb: ParentBattle): void {
    for (const sub of pb.waveRing) {
      if (sub.lifecycle !== 'battling') continue;
      sub.lifecycle = 'leaving';
      sub.battler.startPoofOut();
    }
    pb.waveRing = [];
    pb.wave = 'idle';
    bumpCounter('battlesResolved');
    pb.parentWalker.setForcedBackView(false);
    this.nextBattleEarliestAt = Date.now() + this.randomCooldown();
    this.deps.onBattleEnd(pb.parentId);
    notifyBattleEnd(pb.parentId); // crossfades back to ambient once this was the last active wave anywhere
  }

  /** Defensive equivalent of `concludeWave` for a wave that's stuck or whose
   *  processing just threw (see `update`'s per-parent try/catch and the hard
   *  cap in `updateOneBattle`) — same end state (the challenger poofs away,
   *  the parent's stance releases, the global lock frees) but doesn't
   *  assume anything about the wave's current phase or the battler's
   *  internal state, since this runs from contexts where either could be
   *  corrupted. */
  private forceConcludeWave(pb: ParentBattle): void {
    for (const sub of pb.waveRing) {
      if (sub.lifecycle !== 'battling') continue;
      sub.lifecycle = 'leaving';
      try {
        sub.battler.startPoofOut();
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

  /** Periodic local roam around `sub`'s home tile — mirrors Walker.ts's own
   *  idle wander (updateWander) exactly, just against a Battler instead of a
   *  Walker. */
  private updateRoaming(sub: SubBattler, dt: number): void {
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
  }
}
