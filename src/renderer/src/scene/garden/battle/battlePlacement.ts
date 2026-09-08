/**
 * Pure geometry/placement functions for the battle subsystem — extracted
 * from BattleManager.ts (pure move, no behavior change). Each function that
 * used to reach into `this.battles`/`this.isDelegateSub`/`this.deps` now
 * takes the needed inputs as parameters instead, so this module has no
 * mutable state of its own — see each call site in BattleManager.ts for how
 * those inputs are gathered.
 */
import type { TiledMapRenderer } from '../TiledMapRenderer';
import { targetTileHeight } from '../spriteScale';
import { findPath } from '../pathfinding';
import type { BattleDeps, SubBattler } from './battleTypes';
import { CORNER_MARGIN, GAP_BASE_TILES, GAP_LARGE_BONUS_TILES, LARGE_TILE_THRESHOLD } from './battleTuning';

export function tileKey(t: { x: number; y: number }): string {
  return `${t.x},${t.y}`;
}

export function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Nearest walkable tile to `center` within [minDist, maxDist] (Manhattan),
 *  shuffled among ties for variety. When `reachableFrom` is given, a
 *  candidate must also have an actual BFS path from it — a tile that merely
 *  passes `isWalkable` can still sit in a disconnected pocket (the far side
 *  of a wall/pond), which would leave a battler assigned to walk there stuck
 *  forever (goTo fails silently, by design, to avoid teleporting). Null if
 *  nothing in range qualifies. */
export function findNearbyWalkable(
  map: TiledMapRenderer,
  center: { x: number; y: number },
  minDist: number,
  maxDist: number,
  avoid?: ReadonlySet<string>,
  reachableFrom?: { x: number; y: number },
  /** Extra positional constraint on the ABSOLUTE candidate tile — e.g. "stay
   *  in the parent's SW quadrant" — evaluated alongside walkability/avoid. */
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

/** `parentTile` and `claimedWanderHomes` used to be read straight off
 *  `this.battles`/`pb.parentWalker.tile`/`this.isDelegateSub` — the caller
 *  now gathers those first (see BattleManager.ts's call sites) so this stays
 *  a pure geometry function. */
export function pickRoamHome(
  map: TiledMapRenderer,
  parentTile: { x: number; y: number },
  reachableFrom: { x: number; y: number },
  claimedWanderHomes: ReadonlySet<string>
): { x: number; y: number } {
  const margin = CORNER_MARGIN;
  const corners = [
    { x: margin, y: margin },
    { x: map.width - 1 - margin, y: margin },
    { x: margin, y: map.height - 1 - margin },
    { x: map.width - 1 - margin, y: map.height - 1 - margin }
  ];

  // Weighted-random corner order rather than a hard "farthest 3 of 4" cut:
  // for any parent walker that tends to sit in a similar map region across
  // sessions, the farthest-3 set is nearly always the same, so one corner
  // structurally wins over the long run. Each corner's weight favors
  // distance from the parent, then divides that down by how many already-
  // claimed wander-homes (from the set above) sit near it — a corner that
  // starts filling up loses share to the other three even while it's still
  // the single farthest one, keeping the long-session spread even across
  // all four instead of just among the top three.
  const occupancyRadius = margin * 6;
  const claimedTiles = Array.from(claimedWanderHomes, (key) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  });
  const pool = corners.map((corner) => {
    const dist = manhattan(corner, parentTile);
    const occupancy = claimedTiles.filter((t) => manhattan(t, corner) <= occupancyRadius).length;
    return { corner, weight: Math.max(1, dist) / (1 + occupancy) };
  });
  const order: { x: number; y: number }[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    let r = Math.random() * total;
    let pickIdx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) {
        pickIdx = i;
        break;
      }
    }
    order.push(pool[pickIdx].corner);
    pool.splice(pickIdx, 1);
  }

  for (const corner of order) {
    const home =
      findNearbyWalkable(map, corner, 0, 6, claimedWanderHomes, reachableFrom) ??
      findNearbyWalkable(map, corner, 0, 14, claimedWanderHomes, reachableFrom);
    if (home) return home;
  }
  return parentTile; // pathological: nothing reachable anywhere far — stand near the parent instead
}

/** Face-off gap, in tiles, for this wave — bumped up whenever the parent or
 *  any admitted battler is a large-class sprite so a Snorlax or Tyranitar
 *  never reads as standing inside its opponent. */
export function gapTilesForBatch(deps: BattleDeps, parentId: string, subs: SubBattler[]): number {
  const map = deps.map;
  const parentSpeciesId = deps.getParentSpeciesId(parentId);
  const parentAnimation = parentSpeciesId ? deps.resolveAnimation(parentSpeciesId) : undefined;
  const parentPixels = parentAnimation
    ? targetTileHeight(parentAnimation.info.name, parentAnimation.front.frameHeight) * map.tileSize
    : GAP_BASE_TILES * map.tileSize;
  const maxPixels = subs.reduce((m, s) => Math.max(m, s.battler.drawnHeight), parentPixels);
  const isLarge = maxPixels >= LARGE_TILE_THRESHOLD * map.tileSize;
  return GAP_BASE_TILES + (isLarge ? GAP_LARGE_BONUS_TILES : 0);
}

/**
 * The parent's stand tile for THIS wave — the anchor half of a canonical
 * anchor(parent)/SW(challenger) battle pair (2026-09-04 facing swap: the
 * challenger now takes the SW corner so the parent, unmirrored, can face
 * the camera — see BattleManager.ts's file header). Tries the parent's own
 * current tile first (it may not need to move at all); if that tile has no
 * valid SW partner (or the partner isn't actually reachable from it),
 * widens a shuffled search outward from `originalTile` for an alternate
 * anchor that DOES have one — moving the whole meeting spot to open lawn
 * rather than ever inverting the arrangement. `gap` is the eventual
 * parent-challenger distance on each axis; the anchor only needs its
 * immediate SW corner to be clear, since pickChallengerStandTileFor does
 * its own reachability search from here for the actual stand tile.
 */
export function findMeetingAnchor(
  map: TiledMapRenderer,
  originalTile: { x: number; y: number },
  gap: number
): { x: number; y: number } | null {
  const hasSwPartner = (a: { x: number; y: number }): boolean => {
    if (!map.isWalkable(a.x, a.y)) return false;
    const partner = { x: a.x - gap, y: a.y + gap };
    if (!map.isWalkable(partner.x, partner.y)) return false;
    return findPath(map, a, partner) !== null;
  };
  const reachableFromOriginal = (a: { x: number; y: number }): boolean =>
    (a.x === originalTile.x && a.y === originalTile.y) || findPath(map, originalTile, a) !== null;

  if (hasSwPartner(originalTile)) return originalTile;

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
      if (hasSwPartner(c) && reachableFromOriginal(c)) return c;
    }
  }
  return null;
}

/**
 * A stand tile for ring slot `slot`, ALWAYS somewhere in the SW arc from
 * `anchor` (the parent's stand tile for this wave) — never level with it,
 * never on its top/right side (2026-09-04 facing swap: the challenger now
 * takes the SW corner so the parent, unmirrored, can face the camera — see
 * BattleManager.ts's file header). This is what lets `applyBattleStance`
 * skip all direction math: a native/unmirrored back sheet drawn facing
 * up-right already points at anything placed down-left of it. Up to
 * MAX_RING slots fan across the arc (roughly SW, WSW, SSW) at the same
 * radius so they spread out rather than stacking. Every candidate is
 * BFS-reachable from `anchor` — not just "walkable" — so goTo() is
 * guaranteed to actually get there (no permanently-stuck battler).
 */
export function pickChallengerStandTileFor(
  map: TiledMapRenderer,
  admitted: SubBattler[],
  gap: number,
  slot: number,
  anchor: { x: number; y: number }
): { x: number; y: number } {
  const claimed = new Set<string>([tileKey(anchor)]);
  for (const s of admitted) if (s.battler.standTile) claimed.add(tileKey(s.battler.standTile));

  const arcOffsets = [
    { x: -gap, y: gap },
    { x: -Math.round(gap * 1.4), y: Math.round(gap * 0.6) },
    { x: -Math.round(gap * 0.6), y: Math.round(gap * 1.4) }
  ];
  const primary = arcOffsets[slot % arcOffsets.length];
  const primaryTile = { x: anchor.x + primary.x, y: anchor.y + primary.y };
  if (
    !claimed.has(tileKey(primaryTile)) &&
    map.isWalkable(primaryTile.x, primaryTile.y) &&
    findPath(map, anchor, primaryTile) !== null
  ) {
    return primaryTile;
  }

  // Widen the search but STAY in the SW quadrant relative to the PARENT's
  // anchor (never the search center) — never fall back to its top/right
  // side.
  return (
    findNearbyWalkable(map, primaryTile, 1, gap + 3, claimed, anchor, (c) => c.x <= anchor.x && c.y >= anchor.y) ??
    primaryTile
  );
}
