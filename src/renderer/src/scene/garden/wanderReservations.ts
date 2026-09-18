import type { Point } from './TiledMapRenderer';

/**
 * Tracks where every walker in the garden currently is, or is headed next,
 * so idle walkers picking a new wander destination can spread out instead of
 * converging on the same handful of spots.
 *
 * Replaces the old per-reconcile idle-tile-reservation scheme (v1.20.7):
 * that version claimed one EXACT tile per idle walker and re-checked/
 * re-claimed it from GardenScene.tsx's reconcile loop on every store change
 * — which fought Walker's own wander loop for control and, since idle
 * walkers never actually wandered, left them stuck within a small ring of
 * wherever they'd first spawned (see this project's changelog/bug report:
 * "idle Pokemon cluster in the four corners ... and flick around there").
 * This version tracks an approximate ANCHOR point per walker (its current
 * tile, or the tile it's currently walking toward as its next resting spot)
 * and is driven entirely from each Walker's own update tick — see
 * Walker.ts's `updateWander`/`updateWalk` — never from a reconcile.
 *
 * One instance per GardenScene mount generation, held alongside `runtimes`
 * and passed into every Walker at construction (WalkerOptions.reservations)
 * — see GardenScene.tsx.
 */

/** Minimum straight-line separation (in map tiles) an idle walker's chosen
 *  rest/destination point must keep from every OTHER walker's own anchor.
 *
 *  Derived from spriteScale.ts's own size range: the tallest sheets draw at
 *  LARGE_TILES (3.5) tiles high, and Showdown's front frames run roughly as
 *  wide as they are tall, so a worst-case sprite's drawn footprint is in the
 *  same ballpark both ways. Two such sprites centred exactly LARGE_TILES
 *  apart would already just touch edge-to-edge, so this rounds up a full
 *  extra tile — enough clearance for a visible gap plus the name tag/badge
 *  floating above the head, without being so wide that a crowded map can
 *  never satisfy it (see the bounded fallback below). */
export const MIN_SEPARATION_TILES = 4;

/** Bounded outward search radius (Manhattan rings), in tiles, for
 *  `spreadSpawnTile` — keeps that search bounded even on a small map with
 *  many restored sessions all landing on the same handful of named spawn
 *  points. */
const MAX_SPAWN_SEARCH_RADIUS = 10;

/** Every tile at exactly Manhattan distance `r` from `center` (itself, for
 *  r === 0). */
function ringOffsets(center: Point, r: number): Point[] {
  if (r === 0) return [center];
  const ring: Point[] = [];
  for (let dx = -r; dx <= r; dx++) {
    const dy = r - Math.abs(dx);
    ring.push({ x: center.x + dx, y: center.y + dy });
    if (dy !== 0) ring.push({ x: center.x + dx, y: center.y - dy });
  }
  return ring;
}

export class WanderReservations {
  /** owner id -> the tile it currently occupies, or is walking toward as
   *  the next tile it will rest at. Every walker (idle AND working) keeps
   *  this current — see Walker.ts's arrival hook in `updateWalk` — so an
   *  idle walker picking a new destination can see where a WORKING walker
   *  currently is too, cheaply, without a second bookkeeping structure. */
  private anchors = new Map<string, Point>();

  /** The tile `ownerId` last anchored, or null if it holds none (never
   *  anchored, or released — e.g. its workspace went inactive). */
  anchorOf(ownerId: string): Point | null {
    return this.anchors.get(ownerId) ?? null;
  }

  setAnchor(ownerId: string, tile: Point): void {
    this.anchors.set(ownerId, { x: tile.x, y: tile.y });
  }

  /** Drop `ownerId`'s anchor — walker teardown, or its workspace going
   *  inactive (Phase 8.7: an off-stage walker keeps wandering for itself,
   *  but must stop counting against on-stage walkers' spacing checks, and
   *  vice versa). Idempotent. */
  release(ownerId: string): void {
    this.anchors.delete(ownerId);
  }

  /** Straight-line tile distance from `p` to the NEAREST other walker's
   *  anchor, excluding `exceptOwner`'s own. Infinity when nobody else holds
   *  one yet. */
  distanceToNearest(p: Point, exceptOwner: string): number {
    let min = Infinity;
    for (const [id, a] of this.anchors) {
      if (id === exceptOwner) continue;
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d < min) min = d;
    }
    return min;
  }

  /** Nudge a restored session's computed spawn tile off any OTHER walker
   *  already anchored on (or very near) it — the four named `wander-N`
   *  points restored idle sessions cycle through (STATION_SPAWNS.wander,
   *  slot % 4) are otherwise exactly the same handful of coordinates no
   *  matter how many sessions restore into them, so without this every
   *  4th/8th/12th... restored session would spawn stacked exactly on top of
   *  an earlier one for the several seconds before its first wander leg
   *  fires. Not a full destination search (no reachability/pathfinding —
   *  the walker is placed here directly, not routed): a bounded outward
   *  ring scan from `from`, returning the first candidate at least
   *  `MIN_SEPARATION_TILES` from every other anchor, or — past
   *  MAX_SPAWN_SEARCH_RADIUS rings — whichever candidate seen had the most
   *  clearance, so a crowded map still gets a placement instead of a hang.
   *  Always returns a tile (never null) and does NOT itself claim an
   *  anchor — the caller (Walker's constructor) does that once, for every
   *  walker, tracked or not. */
  spreadSpawnTile(from: Point, ownerId: string, canEnter: (x: number, y: number) => boolean): Point {
    let bestFallback: Point = from;
    let bestFallbackDist = -Infinity;

    for (let r = 0; r <= MAX_SPAWN_SEARCH_RADIUS; r++) {
      for (const candidate of ringOffsets(from, r)) {
        if (!canEnter(candidate.x, candidate.y)) continue;
        const dist = this.distanceToNearest(candidate, ownerId);
        if (dist >= MIN_SEPARATION_TILES) return candidate;
        if (dist > bestFallbackDist) {
          bestFallbackDist = dist;
          bestFallback = candidate;
        }
      }
    }
    return bestFallback;
  }
}
