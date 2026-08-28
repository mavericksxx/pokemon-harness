/**
 * Subagent battles (Phase 4 Part B) — one wild Pokemon per live `Task` tool
 * call, fought out beside the parent session's own walker.
 *
 * State machine per parent session:
 *   alert -> approaching -> faceoff -> looping -> ending
 * driven by `battleBus` signals (spawn/attack/end/endAll — see its header for
 * where each comes from: hooks when live, regex fallback otherwise).
 *
 * FACING IS A FIXED ARRANGEMENT, NOT COMPUTED MIRRORING. The parent always
 * ends up on the bottom-left tile of a battle pair, every challenger always
 * ends up somewhere in the top/right arc from there — never the reverse,
 * never a same-row placement (see pickChallengerStandTile). Because native
 * gen5ani sprites are drawn front-facing down-left and back-facing up-right,
 * an UNMIRRORED front sheet already looks like it's facing the bottom-left
 * corner and an UNMIRRORED back sheet already looks like it's facing the
 * top-right one — so the parent (back, unmirrored) and every challenger
 * (front, unmirrored) simply aim at each other by construction the moment
 * they're placed correctly. `applyBattleStance` sets both to that fixed,
 * unmirrored stance and never computes a direction from position — three
 * earlier attempts at position-derived mirroring each got some case backward,
 * which is exactly the class of bug a fixed arrangement has no room for.
 *
 * Composes with the rest of the garden entirely from the outside: battlers
 * are their own lightweight class (`Battler`, reusing `WalkerSprite` +
 * `findPath`), and the parent's `Walker` is touched only through its already
 * -public `container` (position/FX) plus the two small wrapper methods added
 * for this feature (`showFloatingText`, `setForcedBackView`). The evolution
 * ceremony's exclusivity is respected by simply not touching a walker's
 * container while `walker.isEvolving` — the ceremony reparents it, and
 * fighting over its transform would corrupt both.
 */
import { Container, Text } from 'pixi.js';
import type { Walker } from '../Walker';
import type { TiledMapRenderer } from '../TiledMapRenderer';
import type { PokemonAnimation } from '../showdownArt';
import { DEX_LIST, isBundled, type DexEntry } from '../dexData';
import { targetTileHeight } from '../spriteScale';
import { findPath } from '../pathfinding';
import { onBattleSignal, type BattleSignal } from './battleBus';
import { Battler } from './Battler';
import { spawnExclaimBubble, spawnHitFlash, spawnSparkleBurst, tickBattleFx } from './battleFx';
import { notifyBattleStart, notifyBattleEnd, playAttackSound, playVictoryChime } from '@/audio/audioEngine';

const LUNGE_MS = 150;
const HOLD_MS = 150;
const RETURN_MS = 180;
const ATTACK_TOTAL_MS = LUNGE_MS + HOLD_MS + RETURN_MS;
/** Lunge travels this fraction of the full gap toward the opponent and back
 *  — always well short of contact, whatever the gap or sprite size (see
 *  gapTilesFor). */
const LUNGE_FRACTION = 0.28;
const SHAKE_MS = 180;
const FACEOFF_MS = 550;
const ENDING_MS = 550;
const MAX_VISIBLE_BATTLERS = 3;

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

interface Attack {
  attackerIsParent: boolean;
  /** Meaningful when !attackerIsParent — index into pb.battlers. */
  attackerBattlerIdx: number;
  /** Meaningful when attackerIsParent — index into pb.battlers. */
  targetBattlerIdx: number;
  tool: string;
  combo: number;
  elapsedMs: number;
  hitApplied: boolean;
}

interface ParentBattle {
  parentId: string;
  parentWalker: Walker;
  /** Live, targetable battlers (fanned around the parent). */
  battlers: Battler[];
  /** Battlers mid poof-out — still ticked/drawn until they finish shrinking. */
  leaving: Battler[];
  overflow: number;
  overflowText: Text | null;
  phase: 'alert' | 'approaching' | 'faceoff' | 'looping' | 'ending';
  phaseElapsedMs: number;
  /** Whether the initiation "!" bubbles have already been fired — set once,
   *  guards against re-triggering if update() ticks the 'alert' phase more
   *  than once before the transition callback fires. */
  alertShown: boolean;
  currentAttack: Attack | null;
  lastAttackerWasParent: boolean;
  roundRobinIdx: number;
  /** Where the parent walks TO for this battle — the fixed bottom-left tile
   *  of the battle pair (see findMeetingAnchor), decided once from the
   *  first battler's spawn and reused for every later battler in the same
   *  fight. Null only if picking it somehow failed entirely. */
  parentStandTile: { x: number; y: number } | null;
  /** A tool event that arrived before the battle reached its loop (still
   *  approaching or facing off) — coalesced here instead of dropped, and
   *  opened as the first attack (with its accumulated combo) the instant
   *  face-off completes. */
  pendingTool: string | null;
  pendingCombo: number;
}

export interface BattleDeps {
  map: TiledMapRenderer;
  charLayer: Container;
  /** Bundled species resolve instantly; anything else starts as a pokeball
   *  and is upgraded via loadLazyAnimation, matching GardenScene's own
   *  walkers. */
  resolveAnimation: (species: string) => PokemonAnimation;
  loadLazyAnimation: (species: string) => Promise<PokemonAnimation | null>;
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
  /** Called once a battle fully ends, so the caller can let the parent's
   *  normal station reconcile take back over. */
  onBattleEnd: (parentId: string) => void;
}

function tileKey(t: { x: number; y: number }): string {
  return `${t.x},${t.y}`;
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

  isBattling(parentId: string): boolean {
    return this.battles.has(parentId);
  }

  isMidAttack(parentId: string): boolean {
    return this.battles.get(parentId)?.currentAttack != null;
  }

  /** Call when a parent session's own walker is torn down (session ended)
   *  while a battle was in flight — drops it with no ceremony. */
  forceEnd(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    this.destroyBattle(pb);
    this.battles.delete(parentId);
    notifyBattleEnd(parentId); // a session-kill mid-battle must still hand the music bus back
  }

  dispose(): void {
    this.unsubscribe();
    for (const [parentId, pb] of this.battles) {
      this.destroyBattle(pb);
      notifyBattleEnd(parentId);
    }
    this.battles.clear();
  }

  update(dt: number): void {
    tickBattleFx(dt);
    const finished: string[] = [];
    for (const [parentId, pb] of this.battles) {
      if (pb.parentWalker.isEvolving) {
        // The ceremony owns the parent's container for its duration — don't
        // touch positions; just keep battlers idling/poofing in place.
        for (const b of pb.battlers) b.update(dt);
        for (const b of pb.leaving) b.update(dt);
        this.reapLeaving(pb);
        continue;
      }

      switch (pb.phase) {
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
          pb.phaseElapsedMs += dt * 1000;
          break;
      }

      // Mutual facing, re-derived every tick from actual current tiles —
      // covers the moment face-off begins, every attack's target swap, and
      // self-corrects if a lunge or an evolution reset either sprite's
      // mirroring in between.
      if (pb.phase === 'faceoff' || pb.phase === 'looping') this.applyBattleStance(pb);

      for (const b of pb.battlers) b.update(dt);
      for (const b of pb.leaving) b.update(dt);
      this.reapLeaving(pb);
      this.applyPositions(pb);

      if (pb.phase === 'ending' && pb.phaseElapsedMs >= ENDING_MS && pb.leaving.length === 0) {
        finished.push(parentId);
      }
    }
    for (const id of finished) {
      const pb = this.battles.get(id);
      if (pb) this.destroyBattle(pb);
      this.battles.delete(id);
      notifyBattleEnd(id); // crossfades back to ambient once this was the LAST active battle
      this.deps.onBattleEnd(id);
    }
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
    const isFirstBattler = !pb;
    if (!pb) {
      pb = this.createBattle(parentId, rt.walker);
      this.battles.set(parentId, pb);
      notifyBattleStart(parentId); // crossfades ambient -> battle music (no-op if already battling elsewhere)
    }
    if (pb.phase === 'ending') return; // a straggling spawn after victory

    if (pb.battlers.length >= MAX_VISIBLE_BATTLERS) {
      pb.overflow++;
      this.refreshOverflowBadge(pb);
      return;
    }

    const species = this.pickSpecies();
    if (!species) return; // dex exhausted — extremely unlikely; just drop

    const animation = this.deps.resolveAnimation(species.id);
    const parentSpeciesId = this.deps.getParentSpeciesId(parentId);
    const gap = this.gapTilesFor(parentSpeciesId, animation);
    const slot = pb.battlers.length;

    if (isFirstBattler) {
      // The parent's stand tile is fixed for the whole fight the instant the
      // first opponent shows up: the bottom-left half of a canonical
      // bottom-left/top-right battle pair (see findMeetingAnchor) — never
      // recomputed from where anyone actually walks in from.
      const originalTile = pb.parentWalker.tile;
      pb.parentStandTile = this.findMeetingAnchor(originalTile, gap) ?? originalTile;
      // The actual walk starts only once the "!" alert beat finishes — see
      // the 'alert' case in update(). Not called here.
    }

    const anchor = pb.parentStandTile ?? pb.parentWalker.tile;
    const spawnTile = this.pickFarSpawnTile(anchor);
    const standTile = this.pickChallengerStandTile(pb, gap, slot, anchor);
    const battler = new Battler({ map: this.deps.map, animation, species, spawnTile });
    battler.standTile = standTile;
    this.deps.charLayer.addChild(battler.container);
    pb.battlers.push(battler);
    // While still in the 'alert' beat, hold off — update()'s 'alert' case
    // starts every battler's walk in lockstep with the parent's, once both
    // sides have shown their "!". A battler joining a fight already past
    // that beat just walks in immediately, same as before.
    if (!(pb.phase === 'alert' && !pb.alertShown)) {
      battler.goTo(standTile); // false (unreachable) just leaves it standing at spawnTile — no teleport either way
    }

    if (!isBundled(species.id)) {
      void this.deps.loadLazyAnimation(species.id).then((real) => {
        if (real && pb!.battlers.includes(battler)) battler.setAnimation(real);
      });
    }
  }

  private handleAttack(parentId: string, tool: string): void {
    const pb = this.battles.get(parentId);
    if (!pb || pb.battlers.length === 0 || pb.phase === 'ending') return;
    if (pb.phase !== 'looping') {
      // Still approaching or facing off — the walk-in is the point, so don't
      // shortcut it. Coalesce into a pending combo that opens the battle the
      // instant face-off completes instead of dropping the event.
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
      return;
    }
    this.startAttack(pb, tool);
  }

  private handleEnd(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb) return;
    if (pb.overflow > 0) {
      pb.overflow--;
      this.refreshOverflowBadge(pb);
      return;
    }
    const b = pb.battlers.pop();
    if (b) {
      b.startPoofOut();
      pb.leaving.push(b);
    }
    if (pb.battlers.length === 0 && pb.overflow === 0 && pb.phase !== 'ending') {
      this.beginEnding(pb);
    }
  }

  private handleEndAll(parentId: string): void {
    const pb = this.battles.get(parentId);
    if (!pb || pb.phase === 'ending') return;
    pb.overflow = 0;
    this.refreshOverflowBadge(pb);
    for (const b of pb.battlers) {
      b.startPoofOut();
      pb.leaving.push(b);
    }
    pb.battlers = [];
    this.beginEnding(pb);
  }

  // --- species selection -------------------------------------------------

  private collectExcludedLines(): Set<string> {
    const set = new Set(this.deps.activeSessionLines());
    for (const pb of this.battles.values()) {
      for (const b of pb.battlers) set.add(b.species.line);
      for (const b of pb.leaving) set.add(b.species.line);
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
    // Freeze the parent exactly where it is for the "!" alert beat —
    // goTo(its own tile) is a zero-length path (see pathfinding.ts) that
    // stops any in-flight wander without moving it. The real approach walk
    // (to parentStandTile) is issued once the alert finishes.
    parentWalker.goTo(parentWalker.tile);
    return {
      parentId,
      parentWalker,
      battlers: [],
      leaving: [],
      overflow: 0,
      overflowText: null,
      phase: 'alert',
      phaseElapsedMs: 0,
      alertShown: false,
      currentAttack: null,
      lastAttackerWasParent: false,
      roundRobinIdx: 0,
      parentStandTile: null,
      pendingTool: null,
      pendingCombo: 0
    };
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

  /** Drawn tile-height of a species' sheet — the same normalization
   *  spriteScale() itself uses, read back without needing a live sprite. */
  private drawnTiles(animation: PokemonAnimation): number {
    return targetTileHeight(animation.info.name, animation.front.frameHeight);
  }

  /** Face-off gap, in tiles, for this parent/battler pairing — bumped up
   *  whenever either side is a large-class sprite so a Snorlax or Tyranitar
   *  never reads as standing inside its opponent. */
  private gapTilesFor(parentSpeciesId: string | undefined, battlerAnimation: PokemonAnimation): number {
    const parentAnimation = parentSpeciesId ? this.deps.resolveAnimation(parentSpeciesId) : undefined;
    const parentTiles = parentAnimation ? this.drawnTiles(parentAnimation) : GAP_BASE_TILES;
    const battlerTiles = this.drawnTiles(battlerAnimation);
    const isLarge = Math.max(parentTiles, battlerTiles) >= LARGE_TILE_THRESHOLD;
    return GAP_BASE_TILES + (isLarge ? GAP_LARGE_BONUS_TILES : 0);
  }

  /**
   * The parent's fixed anchor tile for this whole fight — the bottom-left
   * half of a canonical bottom-left(parent)/top-right(challenger) battle
   * pair. Tries the parent's own current tile first (it may not need to
   * move at all); if that tile has no valid NE partner (or the partner isn't
   * actually reachable from it), widens a shuffled search outward from
   * `originalTile` for an alternate anchor that DOES have one — moving the
   * whole meeting spot to open lawn rather than ever inverting the
   * arrangement. `gap` is the eventual parent-challenger distance on each
   * axis; the anchor only needs its immediate NE corner to be clear, since
   * pickChallengerStandTile does its own reachability search from here for
   * the actual stand tile.
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
   * A stand tile for battler `slot`, ALWAYS somewhere in the top/right arc
   * from `anchor` (the parent's fixed stand tile) — never level with it,
   * never on its bottom/left side. This is what lets `applyBattleStance`
   * skip all direction math: an unmirrored front sheet drawn facing
   * down-left already points at anything placed up-right of it. The three
   * slots fan across the arc (roughly NE, ENE, NNE) at the same radius so up
   * to 3 parallel battlers spread out rather than stacking. Every candidate
   * is BFS-reachable from `anchor` — not just "walkable" — so goTo() is
   * guaranteed to actually get there (no permanently-stuck battler).
   */
  private pickChallengerStandTile(
    pb: ParentBattle,
    gap: number,
    slot: number,
    anchor: { x: number; y: number }
  ): { x: number; y: number } {
    const claimed = new Set(pb.battlers.map((b) => tileKey(b.standTile ?? b.tile)));
    claimed.add(tileKey(anchor));

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
   * Every battler (always somewhere in that arc) shows its FRONT sheet
   * UNMIRRORED, which gen5ani draws already aimed down-left at the parent.
   * Placement (findMeetingAnchor / pickChallengerStandTile) is what does the
   * work; this just re-asserts the two fixed, constant stances every tick —
   * idempotent, so it's safe to call from face-off through the whole attack
   * loop, and it self-heals if an evolution's reveal-swap ever resets either
   * sprite's view/facing in between.
   */
  private applyBattleStance(pb: ParentBattle): void {
    pb.parentWalker.setForcedBackView(true);
    pb.parentWalker.faceDirection('left'); // native/unmirrored
    for (const b of pb.battlers) b.setBattleStance();
  }

  /** The "trainer spotted you" beat: once the (first) battler has actually
   *  finished poofing in — a bubble over something still fading in reads
   *  wrong — pop a "!" over both it and the parent, simultaneously, and hold
   *  the whole battle in place until the parent's bubble finishes its pop
   *  in/hold/pop-out cycle. Only then does anyone actually start walking
   *  (see the callback), which is what turns this into a real approach
   *  rather than a shortcut. Guarded by `alertShown` so a phase tick that
   *  lands before the callback fires can't fire the bubbles twice. */
  private updateAlert(pb: ParentBattle): void {
    if (pb.alertShown) return;
    const firstBattler = pb.battlers[0];
    if (!firstBattler || firstBattler.isSpawning) return;
    pb.alertShown = true;
    spawnExclaimBubble(pb.parentWalker.container, -pb.parentWalker.spriteHeight - 8, () => {
      pb.phase = 'approaching';
      pb.phaseElapsedMs = 0;
      pb.parentWalker.goTo(pb.parentStandTile ?? pb.parentWalker.tile);
      for (const b of pb.battlers) {
        if (b.standTile) b.goTo(b.standTile);
      }
    });
    for (const b of pb.battlers) spawnExclaimBubble(b.container, -b.drawnHeight - 6);
  }

  private updateApproaching(pb: ParentBattle): void {
    if (pb.battlers.length === 0) return;
    const battlersArrived = pb.battlers.every((b) => b.arrived);
    const parentTile = pb.parentWalker.tile;
    const parentArrived =
      !pb.parentStandTile || (parentTile.x === pb.parentStandTile.x && parentTile.y === pb.parentStandTile.y);
    if (!battlersArrived || !parentArrived) return;
    pb.phase = 'faceoff';
    pb.phaseElapsedMs = 0;
    this.applyBattleStance(pb);
  }

  private updateFaceoff(pb: ParentBattle, dt: number): void {
    pb.phaseElapsedMs += dt * 1000;
    if (pb.phaseElapsedMs >= FACEOFF_MS) {
      pb.phase = 'looping';
      pb.phaseElapsedMs = 0;
      if (pb.pendingTool) {
        this.startAttack(pb, pb.pendingTool);
        if (pb.currentAttack) pb.currentAttack.combo = pb.pendingCombo;
        pb.pendingTool = null;
        pb.pendingCombo = 0;
      }
    }
  }

  private startAttack(pb: ParentBattle, tool: string): void {
    const attackerIsParent = !pb.lastAttackerWasParent;
    pb.lastAttackerWasParent = attackerIsParent;
    const idx = pb.roundRobinIdx % pb.battlers.length;
    pb.roundRobinIdx++;
    pb.currentAttack = {
      attackerIsParent,
      attackerBattlerIdx: attackerIsParent ? -1 : idx,
      targetBattlerIdx: attackerIsParent ? idx : -1,
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
    if (a.elapsedMs >= ATTACK_TOTAL_MS) pb.currentAttack = null;
  }

  private applyHit(pb: ParentBattle, a: Attack): void {
    const attackerBattler = a.attackerIsParent ? null : pb.battlers[a.attackerBattlerIdx];
    const defenderBattler = a.attackerIsParent ? pb.battlers[a.targetBattlerIdx] : null;
    if (!a.attackerIsParent && !attackerBattler) return;
    if (a.attackerIsParent && !defenderBattler) return;

    const attackerLabel = a.attackerIsParent
      ? this.deps.getParentLabel(pb.parentId)
      : (attackerBattler?.species.name ?? '???');
    const comboSuffix = a.combo > 1 ? ` ×${a.combo}` : '';
    const text = `${attackerLabel} used ${a.tool}!${comboSuffix}`;

    if (a.attackerIsParent) pb.parentWalker.showFloatingText(text);
    else attackerBattler?.showMoveText(text);

    const defenderContainer = a.attackerIsParent ? defenderBattler!.container : pb.parentWalker.container;
    const defenderHeight = a.attackerIsParent ? defenderBattler!.drawnHeight : pb.parentWalker.spriteHeight;
    spawnHitFlash(defenderContainer, Math.max(16, defenderHeight * 0.7), defenderHeight);
    playAttackSound(a.tool); // one sound per rendered lunge — applyHit already respects combo coalescing
  }

  private applyPositions(pb: ParentBattle): void {
    const parentContainer = pb.parentWalker.container;
    parentContainer.x = Math.round(pb.parentWalker.worldX);
    parentContainer.y = Math.round(pb.parentWalker.worldY);
    for (const b of pb.battlers) {
      b.container.x = Math.round(b.worldX);
      b.container.y = Math.round(b.worldY);
    }
    for (const b of pb.leaving) {
      b.container.x = Math.round(b.worldX);
      b.container.y = Math.round(b.worldY);
    }

    if (pb.phase === 'ending') {
      const t = Math.min(1, pb.phaseElapsedMs / ENDING_MS);
      parentContainer.y -= Math.round(Math.sin(t * Math.PI) * 8);
      return;
    }

    const a = pb.currentAttack;
    if (!a) return;

    let progress: number;
    if (a.elapsedMs < LUNGE_MS) progress = a.elapsedMs / LUNGE_MS;
    else if (a.elapsedMs < LUNGE_MS + HOLD_MS) progress = 1;
    else progress = Math.max(0, 1 - (a.elapsedMs - LUNGE_MS - HOLD_MS) / RETURN_MS);

    const attackerContainer = a.attackerIsParent ? parentContainer : pb.battlers[a.attackerBattlerIdx]?.container;
    const defenderContainer = a.attackerIsParent ? pb.battlers[a.targetBattlerIdx]?.container : parentContainer;
    if (attackerContainer && defenderContainer) {
      // A fixed FRACTION of the actual gap, not a fixed pixel distance: it
      // scales with however far apart pickStandTile put these two, so the
      // lunge always stops well short of the opponent's body regardless of
      // sprite size or map layout — never a fixed 10px overshooting a tight
      // gap or undershooting a generous one.
      const dx = defenderContainer.x - attackerContainer.x;
      const dy = defenderContainer.y - attackerContainer.y;
      attackerContainer.x += Math.round(dx * LUNGE_FRACTION * progress);
      attackerContainer.y += Math.round(dy * LUNGE_FRACTION * progress);
    }

    if (a.hitApplied && defenderContainer) {
      const shakeT = (a.elapsedMs - LUNGE_MS) / SHAKE_MS;
      if (shakeT >= 0 && shakeT < 1) {
        const s = (1 - shakeT) * 3;
        defenderContainer.x += Math.round((Math.random() - 0.5) * 2 * s);
        defenderContainer.y += Math.round((Math.random() - 0.5) * 2 * s);
      }
    }
  }

  private refreshOverflowBadge(pb: ParentBattle): void {
    if (pb.overflow <= 0) {
      pb.overflowText?.destroy();
      pb.overflowText = null;
      return;
    }
    if (!pb.overflowText) {
      const t = new Text({
        text: '',
        style: {
          fontSize: 14,
          fontFamily: 'monospace',
          fontWeight: 'bold',
          fill: '#fff6c8',
          stroke: { color: 0x1b1b1b, width: 3 }
        }
      });
      t.anchor.set(0.5, 1);
      t.scale.set(0.45);
      t.zIndex = 100000;
      t.y = -pb.parentWalker.spriteHeight - 10;
      pb.parentWalker.container.addChild(t);
      pb.overflowText = t;
    }
    pb.overflowText.text = `+${pb.overflow}`;
  }

  private reapLeaving(pb: ParentBattle): void {
    if (pb.leaving.length === 0) return;
    pb.leaving = pb.leaving.filter((b) => {
      if (!b.isPoofedOut) return true;
      b.destroy();
      return false;
    });
  }

  private beginEnding(pb: ParentBattle): void {
    pb.phase = 'ending';
    pb.phaseElapsedMs = 0;
    // Cancel any in-flight attack cleanly rather than freezing mid-lunge —
    // applyPositions immediately reverts to plain base positions once
    // currentAttack is null.
    pb.currentAttack = null;
    pb.parentWalker.setForcedBackView(false);
    pb.parentWalker.showFloatingText('Victory!');
    spawnSparkleBurst(pb.parentWalker.container);
    playVictoryChime();
  }

  private destroyBattle(pb: ParentBattle): void {
    pb.overflowText?.destroy();
    for (const b of pb.battlers) b.destroy();
    for (const b of pb.leaving) b.destroy();
    pb.parentWalker.setForcedBackView(false);
  }
}
