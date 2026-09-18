import type { Point } from './TiledMapRenderer';

/**
 * Reserves the tile each non-working walker settles on, so two Pokemon
 * that go idle around the same time don't land on the same spot and
 * visually stack (bug: "idle Pokemon stand on top of each other").
 *
 * One instance per GardenScene mount generation, held alongside `runtimes`
 * — see GardenScene.tsx's idle-placement branch (claims/releases as a
 * session's status crosses in and out of 'working') and
 * walkerLifecycle.ts's `removeWalker` (releases on despawn/teardown, so a
 * destroyed walker's tile doesn't leak forever).
 */

/** Outward search bound, in Manhattan rings, from the walker's own current
 *  tile — keeps `claimNear` a bounded search (never a hang or an unbounded
 *  scan) even on a small map packed with sessions. Past this, the search
 *  gives up on finding a genuinely free tile and falls back to whichever
 *  candidate it saw with the fewest other occupants. */
const MAX_SEARCH_RADIUS = 10;

/** Every tile at exactly Manhattan distance `r` from `center` (its own self
 *  for r === 0). */
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

export class IdleTileReservations {
  /** "x,y" -> session ids currently holding that tile. Normally at most
   *  one; can briefly exceed one only via the least-crowded fallback in
   *  `claimNear` below (deliberate graceful degradation, not a bug). */
  private occupants = new Map<string, Set<string>>();
  /** session id -> the tile it currently holds. */
  private held = new Map<string, Point>();

  private static key(p: Point): string {
    return `${p.x},${p.y}`;
  }

  /** How many sessions OTHER than `exceptOwner` currently hold `p`. */
  private countAt(p: Point, exceptOwner: string): number {
    const set = this.occupants.get(IdleTileReservations.key(p));
    if (!set) return 0;
    return set.has(exceptOwner) ? set.size - 1 : set.size;
  }

  private claim(p: Point, ownerId: string): void {
    const key = IdleTileReservations.key(p);
    let set = this.occupants.get(key);
    if (!set) {
      set = new Set();
      this.occupants.set(key, set);
    }
    set.add(ownerId);
    this.held.set(ownerId, p);
  }

  /** The tile `ownerId` currently holds, or null if it holds none. */
  currentTile(ownerId: string): Point | null {
    return this.held.get(ownerId) ?? null;
  }

  /** Release whatever tile `ownerId` holds. Idempotent — safe to call for a
   *  session that never claimed one (still working, napping in place, or
   *  already released), and safe to call twice. Must be called on every
   *  path off idle placement (resuming work, a battle/errand taking over
   *  the walker's position, and walker teardown) or the tile leaks and the
   *  garden slowly runs out of idle spots. */
  release(ownerId: string): void {
    const prev = this.held.get(ownerId);
    if (!prev) return;
    const set = this.occupants.get(IdleTileReservations.key(prev));
    if (set) {
      set.delete(ownerId);
      if (set.size === 0) this.occupants.delete(IdleTileReservations.key(prev));
    }
    this.held.delete(ownerId);
  }

  /** Find and claim a free tile for `ownerId` to idle on, searching
   *  outward from `from` (the walker's own current tile) in expanding
   *  rings. `from` itself is tried first (radius 0) — a walker that's
   *  already standing somewhere unclaimed just keeps its spot rather than
   *  being walked anywhere. Bounded to MAX_SEARCH_RADIUS rings; if every
   *  candidate in that bound is already taken (small map, many sessions),
   *  falls back to the least-crowded one seen instead of deadlocking or
   *  searching forever. Always returns a tile and always claims it. */
  claimNear(from: Point, ownerId: string, canEnter: (x: number, y: number) => boolean): Point {
    this.release(ownerId);

    let bestFallback: Point | null = null;
    let bestFallbackCount = Infinity;

    for (let r = 0; r <= MAX_SEARCH_RADIUS; r++) {
      for (const candidate of ringOffsets(from, r)) {
        if (!canEnter(candidate.x, candidate.y)) continue;
        const count = this.countAt(candidate, ownerId);
        if (count === 0) {
          this.claim(candidate, ownerId);
          return candidate;
        }
        if (count < bestFallbackCount) {
          bestFallbackCount = count;
          bestFallback = candidate;
        }
      }
    }

    const fallback = bestFallback ?? from;
    this.claim(fallback, ownerId);
    return fallback;
  }

  /** Force `ownerId`'s claim onto exactly `tile`, with no search and no
   *  vacancy check — for a napping walker, which `Walker.goTo` refuses to
   *  move (it sleeps in place by design), so if another session is already
   *  holding the tile it's standing on there is nowhere else to route the
   *  claim to. This makes the reservation match reality (two walkers really
   *  are on that tile) rather than leaving a stale claim on a tile nobody's
   *  on; every OTHER walker's own `claimNear` still counts this tile as
   *  occupied, so a new arrival is steered elsewhere instead of being
   *  routed onto the same spot. */
  claimExact(tile: Point, ownerId: string): void {
    this.release(ownerId);
    this.claim(tile, ownerId);
  }
}
