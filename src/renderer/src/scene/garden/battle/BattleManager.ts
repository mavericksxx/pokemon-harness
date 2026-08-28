/**
 * Subagent battles (Phase 4 Part B, revised Phase 4 Part C) — one wild
 * Pokemon per spawned `Task` subagent, fought out beside the parent
 * session's own walker.
 *
 * ── Lifecycle (Phase 4 Part C) ──────────────────────────────────────────
 * Every spawned subagent gets its own body and its own lifecycle, tracked
 * independently even while several are alive for the same parent at once:
 *
 *   queued -> ring (intro skirmish) -> wandering -> ring (final skirmish)
 *   -> leaving (faint/poof) -> gone
 *
 * On spawn it pops into existence immediately (queued) and, as soon as a
 * "ring" slot is free (MAX_RING at a time, so N near-simultaneous spawns
 * queue rather than fight all at once or vanish into an invisible counter),
 * plays the SAME alert/approach/faceoff/attack choreography this feature
 * always has — except now bounded to a short, scripted skirmish (WAVE_
 * ATTACKS exchanges) instead of running until an external signal says
 * stop. It loses, then WALKS AWAY to a far corner of the map (its own,
 * spread apart from any siblings) and wanders there — visible, alive,
 * doing nothing dramatic — for as long as its real work takes. When it's
 * done, it walks back in for one more skirmish (same ring, reused
 * end-to-end), loses again, and faints/poofs away for good.
 *
 * Why "scripted" rather than driven by real hook signals, and why a
 * safety-net timeout: verified against real transcripts (see hookRouter.ts
 * and hookBridge.ts for the fuller writeup) that Claude Code's Agent/Task
 * tool dispatches every subagent asynchronously — PostToolUse for the
 * dispatch itself fires within ~100-200ms, telling us NOTHING about real
 * completion — and delivers actual completion as an internal message that
 * never reaches the hooks system at all (no SubagentStop, not even
 * UserPromptSubmit for the injected notification). This matches publicly
 * tracked upstream issues (e.g. anthropics/claude-code #25147, #27755,
 * #33049 — background/subagent Stop hooks unreliable or altogether
 * missing). `SubagentStop` is still wired and used opportunistically when
 * it DOES arrive (`handleEnd`), but the only signal this app can actually
 * rely on for "a subagent is done" is a generous wander-duration cap
 * (`WANDER_SAFETY_MS`) — documented here as the deliberate, best-available
 * fallback, not an oversight.
 *
 * FACING IS A FIXED ARRANGEMENT, NOT COMPUTED MIRRORING. The parent always
 * ends up on the bottom-left tile of a battle pair, every challenger always
 * ends up somewhere in the top/right arc from there — never the reverse,
 * never a same-row placement (see pickChallengerStandTileFor). Because
 * native gen5ani sprites are drawn front-facing down-left and back-facing
 * up-right, an UNMIRRORED front sheet already looks like it's facing the
 * bottom-left corner and an UNMIRRORED back sheet already looks like it's
 * facing the top-right one — so the parent (back, unmirrored) and every
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
/** Ring slots — how many subagents choreograph a skirmish with the parent
 *  at once. Extra concurrent spawns/completions queue for the next wave
 *  rather than fighting all at once (cramped) or vanishing into a counter
 *  (Phase 4 Part C: every subagent gets a body, always). Matches the
 *  3-slot arc `pickChallengerStandTileFor` fans across. */
const MAX_RING = 3;
/** Scripted attack exchanges per skirmish (intro OR final) before it
 *  concludes on its own — snappy by design, and the only thing that CAN
 *  conclude it now that real per-subagent signals can't be trusted (see
 *  file header). */
const WAVE_ATTACKS = 2;

/** Minimum face-off gap, in tiles, between the parent and a battler — chosen
 *  so two average-sized sprites (2-2.5 drawn tiles tall) read as clearly
 *  separated rather than overlapping. Bumped up when either side's drawn
 *  height crosses LARGE_TILE_THRESHOLD (a Snorlax/Tyranitar-class sprite). */
const GAP_BASE_TILES = 3;
const GAP_LARGE_BONUS_TILES = 2;
const LARGE_TILE_THRESHOLD = 2.7;

/** A battler spawns genuinely far away — a challenger arriving, not
 *  appearing next to the parent — then BFS-walks in to its stand tile. */
const FAR_SPAWN_MIN_TILES = 8;
const FAR_SPAWN_MAX_TILES = 14;

/** Far-corner wander pacing — mirrors Walker.ts's own idle wander timing/
 *  range exactly, so a wandering subagent reads the same as any other
 *  idling walker in the garden. */
const WANDER_MIN_DELAY = 1.5;
const WANDER_MAX_DELAY = 4.5;
const WANDER_RANGE = 5;
/** How far in from the map edge a "far corner" home sits — enough that a
 *  wandering subagent's own local jitter (WANDER_RANGE) never walks it off
 *  the map or into an unwalkable border. */
const CORNER_MARGIN = 3;
/** Hard cap on how long a subagent may sit in `wandering` before this app
 *  gives up waiting for a completion signal and plays its final battle
 *  anyway — see file header on why this exists at all. Generous: real
 *  subagent work can run for many minutes. NOT exported: diagnosticsCounters
 *  .ts already imports `bumpCounter` FROM this file for its own bumps below
 *  — importing back from there for this constant would make the two modules
 *  circular, an easy-to-miss renderer-boot hazard (a TDZ ReferenceError
 *  depending on which module's body happens to run first) that neither
 *  typecheck nor build reliably catches. Its own divergence threshold just
 *  hardcodes a value comfortably above this one instead, with a comment
 *  tying the two together. */
const WANDER_SAFETY_MS = 8 * 60 * 1000;
/** Watchdog for `alert`/`approaching` specifically — the only two wave
 *  phases NOT bounded purely by dt accumulation (faceoff/looping/ending all
 *  progress on a fixed clock regardless of anyone's position). If a goTo()
 *  target turns out unreachable (a bad wanderHome, a map edge case, a
 *  walker that's stuck for unrelated reasons), the wave would otherwise
 *  pin at that phase forever — `isBattling` never releases the parent, and
 *  `tryAdmitRing` (gated on the wave going idle) never runs again, jamming
 *  every subsequent queued/final-battle subagent behind it too. */
const WAVE_STUCK_MS = 15_000;

/** One spawned subagent's own battler + where it is in its lifecycle.
 *  `bout` records which skirmish a RING membership belongs to (the wave
 *  choreography itself doesn't care, but the wave's conclusion does — an
 *  'intro' loss walks away to wander; a 'final' loss faints for good). */
interface SubBattler {
  key: string;
  battler: Battler;
  lifecycle: 'queued' | 'ring' | 'wandering' | 'leaving';
  bout: 'intro' | 'final';
  wanderHome: { x: number; y: number } | null;
  wanderTimer: number;
  wanderDelay: number;
  /** Epoch ms this battler entered `wandering` — both the FIFO ordering for
   *  an opportunistic SubagentStop (`handleEnd`) and the basis for the
   *  WANDER_SAFETY_MS cap. */
  wanderSince: number;
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
  /** Members of `subs` currently choreographing THIS wave (empty while
   *  `wave === 'idle'`). */
  waveRing: SubBattler[];
  wave: 'idle' | 'alert' | 'approaching' | 'faceoff' | 'looping' | 'ending';
  waveElapsedMs: number;
  waveAttacks: number;
  alertShown: boolean;
  currentAttack: Attack | null;
  lastAttackerWasParent: boolean;
  roundRobinIdx: number;
  /** Where the parent walks TO for the CURRENT wave — recomputed fresh at
   *  the start of every wave (Phase 4 Part C: the parent resumes its own
   *  life between waves and may have moved), unlike Phase 4 Part B where it
   *  was fixed once for the whole battle. */
  parentStandTile: { x: number; y: number } | null;
  /** A tool event that arrived before the wave reached its loop (still
   *  approaching or facing off) — coalesced here instead of dropped, opened
   *  as the first scripted attack's flavor the instant face-off completes. */
  pendingTool: string | null;
  pendingCombo: number;
  nextSeq: number;
  /** Epoch ms the current wave was admitted — the basis for WAVE_STUCK_MS,
   *  the only phases (`alert`/`approaching`) that can otherwise hang
   *  forever if a goTo() target turns out unreachable (faceoff/looping/
   *  ending are all bounded purely by dt accumulation, independent of
   *  anyone actually arriving anywhere). */
  waveStartedAt: number;
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
   *  i.e. whenever the parent is free to resume its own normal life, which
   *  can happen more than once per subagent's full lifetime (once after its
   *  intro skirmish, again after its final one). */
  onBattleEnd: (parentId: string) => void;
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

  constructor(private deps: BattleDeps) {
    this.unsubscribe = onBattleSignal((sig) => this.onSignal(sig));
  }

  /** True while this parent's walker should stay frozen in battle stance —
   *  i.e. an intro or final skirmish is actively choreographing. False while
   *  its subagents are merely wandering (the parent has resumed its own
   *  normal life in between), even though `subs` may still be non-empty. */
  isBattling(parentId: string): boolean {
    const pb = this.battles.get(parentId);
    return !!pb && pb.wave !== 'idle';
  }

  isMidAttack(parentId: string): boolean {
    return this.battles.get(parentId)?.currentAttack != null;
  }

  /** Workspace scoping (Phase 8.7): toggles a parent's battle visuals on or
   *  off without touching the state machine — a battle for a session in an
   *  inactive workspace keeps running (wave/wander/final all still progress,
   *  same as any other background session's work) but stays invisible until
   *  that workspace is active again. Needed because a challenger's
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
   *  while any subagent (ring/wandering/leaving) was still alive — drops
   *  everything with no ceremony, guaranteeing no stuck pokemon survives a
   *  killed session. */
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

  update(dt: number): void {
    tickBattleFx(dt);
    const finishedParents: string[] = [];

    for (const [parentId, pb] of this.battles) {
      if (pb.parentWalker.isEvolving) {
        // The ceremony owns the parent's container for its duration — don't
        // touch positions; just keep every subagent idling/wandering/poofing
        // in place.
        for (const sub of pb.subs) sub.battler.update(dt);
        this.reapSubs(pb);
        if (pb.subs.length === 0 && pb.wave === 'idle') finishedParents.push(parentId);
        continue;
      }

      if (pb.wave === 'idle') this.tryAdmitRing(pb);

      // Watchdog: `alert`/`approaching` are the only phases that wait on
      // something happening in the world (a poof finishing, a goTo()
      // actually arriving) rather than a fixed clock — see WAVE_STUCK_MS.
      if (
        (pb.wave === 'alert' || pb.wave === 'approaching') &&
        Date.now() - pb.waveStartedAt >= WAVE_STUCK_MS
      ) {
        this.concludeWave(pb);
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
        if (sub.lifecycle === 'wandering') {
          this.updateWandering(sub, dt);
          if (Date.now() - sub.wanderSince >= WANDER_SAFETY_MS) this.concludeWander(sub);
        }
        sub.battler.update(dt);
      }
      this.reapSubs(pb);
      this.applyPositions(pb);

      if (pb.subs.length === 0 && pb.wave === 'idle') finishedParents.push(parentId);
    }

    for (const parentId of finishedParents) this.battles.delete(parentId);
  }

  // --- signal handling -------------------------------------------------

  private onSignal(sig: BattleSignal): void {
    switch (sig.type) {
      case 'spawn':
        this.handleSpawn(sig.parentId);
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
    }
  }

  private handleSpawn(parentId: string): void {
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
    const spawnTile = this.pickFarSpawnTile(pb.parentWalker.tile);
    const battler = new Battler({ map: this.deps.map, animation, species, spawnTile });
    this.deps.charLayer.addChild(battler.container);

    const sub: SubBattler = {
      key: `${parentId}#${pb.nextSeq++}`,
      battler,
      lifecycle: 'queued',
      bout: 'intro',
      wanderHome: null,
      wanderTimer: 0,
      wanderDelay: WANDER_MIN_DELAY,
      wanderSince: 0
    };
    pb.subs.push(sub);
    // "Materialized" (vs. hookRouter.ts's "spawned" bump on the Task tool
    // call itself) — this is the point a real battler enters the world; the
    // gap between the two counters is exactly the `!rt`/`!species` guards
    // above.
    bumpCounter('subagentsMaterialized');

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
   *  this concludes the OLDEST currently-wandering subagent for the parent —
   *  the best available guess, and the same "no real correlation, do
   *  something reasonable" position the pre-existing regex-fallback path
   *  (`endAll`) was already in. */
  private handleEnd(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    let oldest: SubBattler | null = null;
    for (const sub of pb.subs) {
      if (sub.lifecycle !== 'wandering') continue;
      if (!oldest || sub.wanderSince < oldest.wanderSince) oldest = sub;
    }
    if (oldest) this.concludeWander(oldest);
  }

  /** Regex-fallback heuristic (or a general "give up on this parent's
   *  subagents" signal): the parent went idle/blocked with no clean
   *  per-subagent completion signal available. No re-fight ceremony for
   *  potentially several stragglers at once — just a clean, snappy poof,
   *  matching this signal's own coarse, "probably all done" nature. */
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
      waveStartedAt: 0
    };
  }

  /** Admit up to MAX_RING queued subagents (FIFO) into a fresh wave — an
   *  intro skirmish for a brand-new spawn, a final skirmish for one whose
   *  wander just concluded (`concludeWander` re-queues it). No-op if
   *  nothing is queued or a wave is already active. */
  private tryAdmitRing(pb: ParentBattle): void {
    const queued = pb.subs.filter((s) => s.lifecycle === 'queued');
    if (queued.length === 0) return;

    const admitted = queued.slice(0, MAX_RING);
    for (const sub of admitted) sub.lifecycle = 'ring';
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

    // A fresh stand tile every wave (not fixed once for the whole battle,
    // per Phase 4 Part B) — the parent may have moved during the last
    // wander gap.
    const gap = this.gapTilesForBatch(pb.parentId, admitted);
    const originalTile = pb.parentWalker.tile;
    pb.parentStandTile = this.findMeetingAnchor(originalTile, gap) ?? originalTile;

    const anchor = pb.parentStandTile;
    admitted.forEach((sub, slot) => {
      sub.battler.standTile = this.pickChallengerStandTileFor(admitted, gap, slot, anchor);
    });

    notifyBattleStart(pb.parentId); // crossfades ambient -> battle music (no-op if already battling elsewhere)
  }

  /** A tile genuinely far from `anchor` — a challenger arriving from beyond
   *  the immediate area, not appearing next to the parent. Falls back to
   *  progressively closer rings so a small/cramped map still spawns
   *  something rather than nothing. */
  private pickFarSpawnTile(anchor: { x: number; y: number }): { x: number; y: number } {
    return (
      findNearbyWalkable(this.deps.map, anchor, FAR_SPAWN_MIN_TILES, FAR_SPAWN_MAX_TILES, undefined, anchor) ??
      findNearbyWalkable(this.deps.map, anchor, 5, FAR_SPAWN_MIN_TILES - 1, undefined, anchor) ??
      findNearbyWalkable(this.deps.map, anchor, 2, 4, undefined, anchor) ??
      anchor
    );
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
   *  (see the callback). A ring member re-entering for its FINAL skirmish
   *  already has a live (non-spawning) battler, so this proceeds
   *  immediately for it. */
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
    pb.parentWalker.showFloatingText('Victory!');
    spawnSparkleBurst(pb.parentWalker.container);
    playVictoryChime();
  }

  private updateEnding(pb: ParentBattle, dt: number): void {
    pb.waveElapsedMs += dt * 1000;
    if (pb.waveElapsedMs >= ENDING_MS) this.concludeWave(pb);
  }

  /** The wave is over — every ring member either loses its intro (walks
   *  away to wander) or loses its final (faints/poofs for good). Frees the
   *  ring for the next queued batch, if any, and lets the parent resume its
   *  own life for as long as nothing else needs it. */
  private concludeWave(pb: ParentBattle): void {
    for (const sub of pb.waveRing) {
      if (sub.lifecycle !== 'ring') continue;
      if (sub.bout === 'final') {
        sub.lifecycle = 'leaving';
        sub.battler.startPoofOut();
      } else {
        sub.lifecycle = 'wandering';
        sub.wanderHome = this.pickWanderHome(pb, sub.battler.tile);
        sub.wanderSince = Date.now();
        sub.wanderTimer = 0;
        sub.wanderDelay = WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY);
        sub.battler.goTo(sub.wanderHome);
      }
    }
    pb.waveRing = [];
    pb.wave = 'idle';
    bumpCounter('battlesResolved');
    pb.parentWalker.setForcedBackView(false);
    this.deps.onBattleEnd(pb.parentId);
    notifyBattleEnd(pb.parentId); // crossfades back to ambient once this was the last active wave anywhere
  }

  /** A far corner of the map, well apart from any sibling already wandering
   *  there — the farthest corner from the parent's CURRENT position (picked
   *  fresh per subagent, since the parent may have moved since the last
   *  one), with local jitter/avoidance spreading multiple wanderers out
   *  instead of stacking on the same tile. `fromTile` (where the battler
   *  actually is right now, about to `goTo` this) is passed as
   *  `reachableFrom` — a tile that merely passes `isWalkable` can still sit
   *  in a disconnected pocket (the far side of a wall/pond), which would
   *  leave this battler standing frozen forever once it goTo()s there and
   *  the path silently fails (same reasoning `pickFarSpawnTile` and
   *  `pickChallengerStandTileFor` already apply). Falls back toward the
   *  parent only in the pathological case where nowhere far is reachable at
   *  all. */
  private pickWanderHome(pb: ParentBattle, fromTile: { x: number; y: number }): { x: number; y: number } {
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
      if (sub.lifecycle === 'wandering' && sub.wanderHome) claimed.add(tileKey(sub.wanderHome));
    }

    for (const corner of corners) {
      const home =
        findNearbyWalkable(map, corner, 0, 6, claimed, fromTile) ??
        findNearbyWalkable(map, corner, 0, 14, claimed, fromTile);
      if (home) return home;
    }
    return parentTile; // pathological: nothing reachable anywhere far — stand near the parent instead
  }

  /** Periodic local wander around `sub`'s far-corner home — mirrors
   *  Walker.ts's own idle wander (updateWander) exactly, just against a
   *  Battler instead of a Walker. */
  private updateWandering(sub: SubBattler, dt: number): void {
    if (!sub.wanderHome) return;
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

  /** A wandering subagent is done (a real completion signal, or the safety
   *  cap) — re-queue it for a final skirmish instead of removing it
   *  directly, so the final battle reuses the exact same ring/wave
   *  choreography as the intro one. */
  private concludeWander(sub: SubBattler): void {
    if (sub.lifecycle !== 'wandering') return;
    sub.lifecycle = 'queued';
    sub.bout = 'final';
    sub.wanderHome = null;
  }

  private reapSubs(pb: ParentBattle): void {
    if (!pb.subs.some((s) => s.lifecycle === 'leaving' && s.battler.isPoofedOut)) return;
    pb.subs = pb.subs.filter((sub) => {
      if (sub.lifecycle !== 'leaving' || !sub.battler.isPoofedOut) return true;
      sub.battler.destroy();
      bumpCounter('subagentsCleanedUp');
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
    }
    pb.parentWalker.setForcedBackView(false);
  }
}
