/**
 * Subagent battles (Phase 4 Part B) — one wild Pokemon per live `Task` tool
 * call, fought out beside the parent session's own walker.
 *
 * State machine per parent session:
 *   approaching -> faceoff -> looping -> ending
 * driven by `battleBus` signals (spawn/attack/end/endAll — see its header for
 * where each comes from: hooks when live, regex fallback otherwise).
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
import { onBattleSignal, type BattleSignal } from './battleBus';
import { Battler } from './Battler';
import { spawnHitFlash, spawnSparkleBurst, tickBattleFx } from './battleFx';

const LUNGE_MS = 150;
const HOLD_MS = 150;
const RETURN_MS = 180;
const ATTACK_TOTAL_MS = LUNGE_MS + HOLD_MS + RETURN_MS;
const LUNGE_DIST_X = 10;
const LUNGE_DIST_Y = 4;
const SHAKE_MS = 180;
const FACEOFF_MS = 550;
const ENDING_MS = 550;
const MAX_VISIBLE_BATTLERS = 3;

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
  phase: 'approaching' | 'faceoff' | 'looping' | 'ending';
  phaseElapsedMs: number;
  frontTile: { x: number; y: number };
  fanTiles: { x: number; y: number }[];
  currentAttack: Attack | null;
  lastAttackerWasParent: boolean;
  roundRobinIdx: number;
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
 *  shuffled among ties for variety. Null if nothing in range qualifies. */
function findNearbyWalkable(
  map: TiledMapRenderer,
  center: { x: number; y: number },
  minDist: number,
  maxDist: number,
  avoid?: ReadonlySet<string>
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
    if (map.isWalkable(c.x, c.y)) return { x: c.x, y: c.y };
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
  }

  dispose(): void {
    this.unsubscribe();
    for (const pb of this.battles.values()) this.destroyBattle(pb);
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
        case 'approaching':
          this.updateApproaching(pb);
          break;
        case 'faceoff':
          this.updateFaceoff(pb, dt);
          break;
        case 'looping':
          // Re-assert every tick, idempotently (WalkerSprite.setBackView
          // no-ops once already in the target state): an evolution ceremony
          // mid-battle resets the sprite to its front view on the reveal
          // swap (setAnimation), which would otherwise silently drop the
          // battle stance once the ceremony hands the walker back.
          pb.parentWalker.setForcedBackView(true);
          if (pb.currentAttack) this.advanceAttack(pb, dt);
          break;
        case 'ending':
          pb.phaseElapsedMs += dt * 1000;
          break;
      }

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
    if (!pb) {
      pb = this.createBattle(parentId, rt.walker);
      this.battles.set(parentId, pb);
    }
    if (pb.phase === 'ending') return; // a straggling spawn after victory

    if (pb.battlers.length >= MAX_VISIBLE_BATTLERS) {
      pb.overflow++;
      this.refreshOverflowBadge(pb);
      return;
    }

    const species = this.pickSpecies();
    if (!species) return; // dex exhausted — extremely unlikely; just drop

    const slot = pb.battlers.length;
    const fanTile = pb.fanTiles[slot] ?? pb.frontTile;
    const avoid = new Set([tileKey(pb.parentWalker.tile), ...pb.fanTiles.map(tileKey)]);
    const spawnTile = findNearbyWalkable(this.deps.map, fanTile, 2, 5, avoid) ?? fanTile;

    const animation = this.deps.resolveAnimation(species.id);
    const battler = new Battler({ map: this.deps.map, animation, species, spawnTile });
    this.deps.charLayer.addChild(battler.container);
    pb.battlers.push(battler);
    battler.goTo(fanTile); // false (unreachable) just leaves it standing at spawnTile — no teleport either way

    if (!isBundled(species.id)) {
      void this.deps.loadLazyAnimation(species.id).then((real) => {
        if (real && pb!.battlers.includes(battler)) battler.setAnimation(real);
      });
    }
  }

  private handleAttack(parentId: string, tool: string): void {
    const pb = this.battles.get(parentId);
    if (!pb || pb.phase !== 'looping' || pb.battlers.length === 0) return;
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
    // Freeze the parent exactly where it is — goTo(its own tile) is a
    // zero-length path (see pathfinding.ts) that stops any in-flight wander
    // without moving it, so a battle never starts with the parent drifting.
    parentWalker.goTo(parentWalker.tile);
    const parentTile = parentWalker.tile;
    const frontTile = findNearbyWalkable(this.deps.map, parentTile, 1, 3) ?? parentTile;
    const fanTiles = this.computeFanTiles(frontTile, parentTile);
    return {
      parentId,
      parentWalker,
      battlers: [],
      leaving: [],
      overflow: 0,
      overflowText: null,
      phase: 'approaching',
      phaseElapsedMs: 0,
      frontTile,
      fanTiles,
      currentAttack: null,
      lastAttackerWasParent: false,
      roundRobinIdx: 0
    };
  }

  /** Up to 3 tiles fanned around the meeting point, avoiding the parent's own
   *  tile. Degenerates to repeating `front` on a very cramped map — battlers
   *  will simply stand close together rather than fail to spawn. */
  private computeFanTiles(
    front: { x: number; y: number },
    parentTile: { x: number; y: number }
  ): { x: number; y: number }[] {
    const avoid = new Set([tileKey(parentTile)]);
    const out: { x: number; y: number }[] = [];
    const seeds = [
      front,
      { x: front.x + 1, y: front.y },
      { x: front.x - 1, y: front.y },
      { x: front.x, y: front.y + 1 }
    ];
    for (const seed of seeds) {
      if (out.length >= MAX_VISIBLE_BATTLERS) break;
      const localAvoid = new Set([...avoid, ...out.map(tileKey)]);
      const t =
        this.deps.map.isWalkable(seed.x, seed.y) && !localAvoid.has(tileKey(seed))
          ? seed
          : findNearbyWalkable(this.deps.map, seed, 0, 2, localAvoid);
      if (t) out.push(t);
    }
    while (out.length < MAX_VISIBLE_BATTLERS) out.push(front);
    return out;
  }

  private updateApproaching(pb: ParentBattle): void {
    if (pb.battlers.length === 0) return;
    const allSettled = pb.battlers.every((b) => b.arrived);
    if (!allSettled) return;
    pb.phase = 'faceoff';
    pb.phaseElapsedMs = 0;
    pb.parentWalker.setForcedBackView(true);
    for (const b of pb.battlers) b.faceToward(pb.parentWalker.tile);
  }

  private updateFaceoff(pb: ParentBattle, dt: number): void {
    pb.phaseElapsedMs += dt * 1000;
    if (pb.phaseElapsedMs >= FACEOFF_MS) {
      pb.phase = 'looping';
      pb.phaseElapsedMs = 0;
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
      const dx = defenderContainer.x - attackerContainer.x;
      const dy = defenderContainer.y - attackerContainer.y;
      const dist = Math.hypot(dx, dy) || 1;
      attackerContainer.x += Math.round((dx / dist) * LUNGE_DIST_X * progress);
      attackerContainer.y += Math.round((dy / dist) * LUNGE_DIST_Y * progress);
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
  }

  private destroyBattle(pb: ParentBattle): void {
    pb.overflowText?.destroy();
    for (const b of pb.battlers) b.destroy();
    for (const b of pb.leaving) b.destroy();
    pb.parentWalker.setForcedBackView(false);
  }
}
