// BFS pathfinding on a tile walkability grid.
// Ported VERBATIM from munder-difflin (src/renderer/src/scene/office/pathfinding.ts),
// which ports it verbatim from shahar061/the-office (office/engine/pathfinding.ts).

export interface Walkable {
  width: number;
  height: number;
  isWalkable(x: number, y: number): boolean;
}

interface Point {
  x: number;
  y: number;
}

const DIRECTIONS: Point[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 }
];

/**
 * `canEnter` overrides the map's own walkability for one search. It exists so a
 * flying Pokemon can cross the pond that a walking one has to go around, without
 * a second grid: the map stays the single source of truth and the caller widens
 * what counts as passable for itself.
 */
export function findPath(
  map: Walkable,
  start: Point,
  goal: Point,
  canEnter: (x: number, y: number) => boolean = (x, y) => map.isWalkable(x, y)
): Point[] | null {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!canEnter(goal.x, goal.y)) return null;

  const key = (p: Point): string => `${p.x},${p.y}`;
  const visited = new Set<string>();
  const parent = new Map<string, Point>();
  const queue: Point[] = [start];
  visited.add(key(start));

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const dir of DIRECTIONS) {
      const next: Point = { x: current.x + dir.x, y: current.y + dir.y };
      const nextKey = key(next);

      if (visited.has(nextKey) || !canEnter(next.x, next.y)) continue;

      visited.add(nextKey);
      parent.set(nextKey, current);

      if (next.x === goal.x && next.y === goal.y) {
        return reconstructPath(parent, start, goal);
      }

      queue.push(next);
    }
  }

  return null;
}

function reconstructPath(parent: Map<string, Point>, start: Point, goal: Point): Point[] {
  const path: Point[] = [];
  let current = goal;
  const key = (p: Point): string => `${p.x},${p.y}`;

  while (!(current.x === start.x && current.y === start.y)) {
    path.unshift(current);
    current = parent.get(key(current))!;
  }

  return path;
}
