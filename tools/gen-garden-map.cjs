#!/usr/bin/env node
'use strict';
/**
 * Generate the garden map (`src/renderer/src/scene/garden/maps/garden.tmj`).
 *
 * Output is a standard Tiled .tmj using the layer convention munder-difflin /
 * the-office use:
 *
 *   tile layers:   floor, walls, furniture-below, furniture-above, collision
 *   object groups: spawn-points, zones
 *
 * The runtime loads it generically — nothing in TiledMapRenderer knows the map
 * was generated. Tileset metadata (image, columns, tilecount, the pond sheet's
 * animation block layout) is read from maps/gardenTilesets.json, the same file
 * gardenArt.ts loads images from, so gids can never drift from the painter.
 *
 * Run with `npm run gen:map`.
 */
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const MAPS_DIR = join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'garden', 'maps');
const TS = JSON.parse(readFileSync(join(MAPS_DIR, 'gardenTilesets.json'), 'utf8'));

const W = 48;
const H = 32;
const T = TS.tilewidth;

// ── gid arithmetic ──────────────────────────────────────────────────────────
// Tilesets are laid out back to back, ascending firstgid, exactly as Tiled does.
const FIRSTGID = [];
{
  let g = 1;
  for (const t of TS.tilesets) {
    FIRSTGID.push(g);
    g += t.tilecount;
  }
}
const setIndex = (name) => TS.tilesets.findIndex((t) => t.name === name);
const KENNEY = setIndex('kenney-tiny-town');
const POND = setIndex('grasswater-pond');
const FLOWERS = setIndex('oga-mostly-flowers');

/** Kenney Tiny Town local id → gid. Ids are the 12-column packed sheet's. */
const k = (id) => FIRSTGID[KENNEY] + id;
/** OGA flowers local id → gid (64-column grid). */
const f = (id) => FIRSTGID[FLOWERS] + id;

// The pond sheet repeats one 11x8 block eight times with the water in a
// different phase. Callers address a tile by its position in block 0; this maps
// that to the sheet-wide local id of animation frame `frame`.
const A = TS.tilesets[POND].animation;
const pondLocal = (blockId, frame) => {
  const c = blockId % A.blockCols;
  const r = Math.floor(blockId / A.blockCols);
  const bx = frame % A.blocksAcross;
  const by = Math.floor(frame / A.blocksAcross);
  return (by * A.blockRows + r) * TS.tilesets[POND].columns + bx * A.blockCols + c;
};
/** Pond block-0 tile → gid of its first animation frame. */
const p = (blockId) => FIRSTGID[POND] + pondLocal(blockId, 0);

// ── named tiles ─────────────────────────────────────────────────────────────
// Kenney Tiny Town (192x176, 12 cols). Ids read off the sheet by inspection
// (rendered at high zoom with a labelled grid overlay — see assets/garden/
// sources.md for the general layout note). The sheet is mostly nature props,
// but rows 4-10 are a small building kit (walls, windows, roof gables, doors,
// posts/rails, a well, flagstone) that the original map never touched.
const GRASS = [k(0), k(1), k(2), k(43)]; // plain, tufted, flowered, pebbled
const DIRT = [
  [k(12), k(13), k(14)],
  [k(24), k(25), k(26)],
  [k(36), k(37), k(38)]
]; // 3x3 dirt patch with grass-blended edges — indexed [row][col] by neighbours
const FENCE = [
  [k(44), k(45), k(46)],
  [k(56), 0, k(58)],
  [k(68), k(69), k(70)]
];
const TREE_CANOPY = [k(4), k(3)]; // green, autumn
const TREE_TRUNK = [k(16), k(15)];
const BUSH = k(5);
const SMALL_TREE = k(28);
const SHRUB = k(17);
const MUSHROOMS = k(29);
const SIGNPOST = k(83);
const MAILBOX = k(95); // a red post on a stake — the second "waiting on you" spot
const WORKBENCH = k(106); // a felled log — the "run a command here" station
const CRATE = k(103);
const BEEHIVE = k(94);

// Building kit, rows 4-10 of the same sheet.
const WALL_STONE = k(76); // plain gray stone block, tileable
const WALL_STONE_ALT = k(79); // same wall, opposite edge variant (visually near-identical)
const DOOR_STONE = k(78); // an open, empty doorway cut into the stone wall
const ROOF_GABLE = k(63); // peaked gray-blue roof cap
/** A tall single well: roof cap over a stone-rimmed shaft of water. Two tiles
 *  stacked (roof directly above the shaft), same trunk/canopy split as a tree:
 *  WELL_BASE blocks and anchors the y-sort, WELL_ROOF sits one row above it in
 *  furniture-above. */
const WELL_ROOF = k(92);
const WELL_BASE = k(104);
// Flagstone nine-slice — same edge-blended-border idea as DIRT, for the well
// plaza and any other paved area that isn't a dirt path.
const STONE = [
  [k(108), k(109), k(110)],
  [k(96), k(97), k(98)],
  [k(120), k(121), k(122)]
];
// A small broken gate: a stone arch you walk under. ARCH_TOP is the lintel
// (canopy convention — one row above the walkable base it shades); ARCH_BASE
// is the open, walkable threshold under it.
const ARCH_TOP = [k(111), k(112)];
const ARCH_BASE = [k(123), k(124)];
// A wood post-and-rail frame (the same pieces the perimeter fence uses,
// repurposed as a small open gazebo — corners + rails, no roof, no occluding
// mass, one gap left open as the entrance).
const GAZEBO_TOP = [k(44), k(45), k(46)];
const GAZEBO_MID = [k(56), k(58)];
const GAZEBO_BOTTOM = [k(68), k(69), k(70)];

// OGA "mostly flowers" (1024x207, 64 cols). Row 0 is the bloomed stage.
const FLOWER_BED = [f(25), f(29), f(31), f(34), f(36), f(39)];
const GRASS_TUFT = [f(273), f(274), f(275), f(20), f(21)];
/** A seamless pale sand/gravel tile — the rocky bank patch by the pond. */
const SAND = f(256);
/** Loose stones of various sizes, scattered on sand or grass. */
const ROCK = [f(280), f(281), f(282), f(283), f(284), f(285), f(286), f(287)];

// Pond nine-slice, addressed in block-0 coordinates of the grasswater sheet.
// Derived by classifying each block-0 tile by where its land pixels sit (top /
// bottom / left / right border strips) — see tools notes in ASSETS.md.
const POND_NW = p(6);
const POND_N = p(7);
const POND_NE = p(8);
const POND_W = p(20);
const POND_C = [p(21), p(32), p(43)];
const POND_E = p(57);
const POND_SW = p(50);
const POND_S = p(18);
const POND_SE = p(52);
/** A single grass tile ringed by its own shoreline — an island in open water. */
const POND_ISLAND = p(56);
const POND_TILES = [
  POND_NW, POND_N, POND_NE, POND_W, ...POND_C, POND_E, POND_SW, POND_S, POND_SE, POND_ISLAND
];

// ── grid helpers ────────────────────────────────────────────────────────────
// Deterministic PRNG so regenerating the map produces byte-identical output.
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

const blank = () => new Array(W * H).fill(0);
const idx = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const put = (layer, x, y, gid) => {
  if (inside(x, y)) layer[idx(x, y)] = gid;
};

const floor = blank();
const walls = blank();
const below = blank();
const above = blank();
const collision = blank();
// Water is blocked in `collision` like anything else, but marked here too so the
// runtime can tell "solid" from "wet": a flying Pokemon crosses the pond that a
// walking one has to go around. Not in the renderer's TILE_LAYERS, so never drawn.
const water = blank();

const isPath = Array.from({ length: H }, () => new Array(W).fill(false));
/** Tiles claimed by paths / pond / beds / props, so scatter never lands on them. */
const claimed = Array.from({ length: H }, () => new Array(W).fill(false));
const claim = (x, y) => {
  if (inside(x, y)) claimed[y][x] = true;
};
const free = (x, y) => inside(x, y) && !claimed[y][x];
/** Same as `claim`, but throws if the tile is already spoken for — used while
 *  laying out the new structures, so two features overlapping is a build-time
 *  error instead of one silently overpainting the other. */
const claimOrThrow = (x, y, label) => {
  if (!inside(x, y)) throw new Error(`${label} at ${x},${y} is off the map`);
  if (claimed[y][x]) throw new Error(`${label} at ${x},${y} collides with something already placed`);
  claimed[y][x] = true;
};

const block = (x, y) => put(collision, x, y, k(11));

// ── floor: grass, with texture variation ────────────────────────────────────
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const r = rnd();
    put(floor, x, y, r < 0.1 ? GRASS[1] : r < 0.14 ? GRASS[2] : r < 0.16 ? GRASS[3] : GRASS[0]);
  }
}

// ── paths ───────────────────────────────────────────────────────────────────
// Kenney's dirt is a 3x3 patch with grass-blended edges and NO inner-corner
// tiles, so a path must stay 2 wide: every cell then has grass on exactly one
// side of each axis and lands on a real edge tile. A 1-wide path would need a
// tile fringed on both sides, which the sheet does not have.
//
// Narrowness is therefore bought with SHAPE, not width: short segments that turn
// often, rather than the long straight avenues a rectangle list produces.
// `route` walks a polyline whose points are the top-left corner of a
// PATH_W x PATH_W band (2-wide dirt paths everywhere except one wider paved
// approach into the well plaza, which uses this same machinery at width 4 —
// the edge classifier below is neighbour-based, not width-aware, so a wider
// band still lands on real edge tiles).
const PATH_W = 2;
const route = (pts, width = PATH_W) => {
  for (let i = 0; i < pts.length - 1; i++) {
    let [x, y] = pts[i];
    const [tx, ty] = pts[i + 1];
    if (x !== tx && y !== ty) throw new Error(`route segment ${i} is not axis-aligned`);
    const dx = Math.sign(tx - x);
    const dy = Math.sign(ty - y);
    for (;;) {
      for (let a = 0; a < width; a++) {
        for (let b = 0; b < width; b++) if (inside(x + a, y + b)) isPath[y + b][x + a] = true;
      }
      if (x === tx && y === ty) break;
      x += dx;
      y += dy;
    }
  }
};

// The pond sits in the north-east, away from the walks, so its bank stays a
// 1-tile rim instead of merging into a path and reading as one dirt slab.
const PONDR = { x0: 35, y0: 4, x1: 43, y1: 9 };
const inPond = (x, y) => x >= PONDR.x0 && x <= PONDR.x1 && y >= PONDR.y0 && y <= PONDR.y1;

route([[23, 29], [23, 26], [18, 26], [18, 22], [26, 22], [26, 18], [21, 18], [21, 14]]); // gate → centre
route([[21, 14], [30, 14], [30, 11], [34, 11]]); // centre → pond bank
route([[18, 22], [11, 22], [11, 17], [15, 17]]); // west meadow spur
route([[26, 18], [33, 18], [33, 23], [39, 23]]); // east lawn spur
route([[23, 26], [34, 26], [34, 29]]); // south-east spur, toward the well plaza
// A short, wider paved approach where the south-east spur meets the well
// plaza — deliberately a different width AND (below) a different material
// from every other path, so the walk itself signals "you've arrived somewhere".
route([[34, 27], [37, 27]], 4);

// A one-tile sand rim rings the pond, so the water never abuts raw grass — the
// pond sheet's greens are a shade yellower than Kenney's and the joint shows.
for (let y = PONDR.y0 - 1; y <= PONDR.y1 + 1; y++) {
  for (let x = PONDR.x0 - 1; x <= PONDR.x1 + 1; x++) {
    if (inside(x, y) && !inPond(x, y)) isPath[y][x] = true;
  }
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isPath[y][x]) continue;
    // The pond counts as "path" for edging purposes, so the rim blends into the
    // water instead of drawing a grass lip against it.
    const solid = (px, py) => (inside(px, py) ? isPath[py][px] || inPond(px, py) : false);
    const row = !solid(x, y - 1) ? 0 : !solid(x, y + 1) ? 2 : 1;
    const col = !solid(x - 1, y) ? 0 : !solid(x + 1, y) ? 2 : 1;
    put(floor, x, y, DIRT[row][col]);
    claim(x, y);
  }
}

// ── pond ────────────────────────────────────────────────────────────────────
for (let y = PONDR.y0; y <= PONDR.y1; y++) {
  for (let x = PONDR.x0; x <= PONDR.x1; x++) {
    const n = y === PONDR.y0;
    const s = y === PONDR.y1;
    const w = x === PONDR.x0;
    const e = x === PONDR.x1;
    const gid = n
      ? w
        ? POND_NW
        : e
          ? POND_NE
          : POND_N
      : s
        ? w
          ? POND_SW
          : e
            ? POND_SE
            : POND_S
        : w
          ? POND_W
          : e
            ? POND_E
            : pick(POND_C);
    put(floor, x, y, gid);
    block(x, y);
    put(water, x, y, gid);
    claim(x, y);
  }
}

// ── walls: a wooden fence around the whole garden, with a gate at the south ──
const GATE = [23, 24];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const n = y === 0;
    const s = y === H - 1;
    const w = x === 0;
    const e = x === W - 1;
    if (!n && !s && !w && !e) continue;
    if (s && GATE.includes(x)) continue; // the gate opening
    put(walls, x, y, FENCE[n ? 0 : s ? 2 : 1][w ? 0 : e ? 2 : 1]);
    block(x, y);
    claim(x, y);
  }
}

// ── structures ──────────────────────────────────────────────────────────────
// Distinct built features, laid out before the general stations/trees/scatter
// passes so those can `claim()`-check around them. Every footprint tile is
// claimed with `claimOrThrow`, so two structures (or a structure and a bed)
// overlapping fails `npm run gen:map` immediately instead of silently
// overpainting.
//
// `STRUCTURES` records each enclosed structure's zone for the .tmj `zones`
// layer below (type `structure`, read by TiledMapRenderer for the roof fade).
const STRUCTURES = [];

/**
 * An enclosed potting shed: three walls and a peaked roof over a single-tile
 * interior, with an open doorway on the south side. The ENTIRE roof — walls,
 * gable and the tile over the interior — is painted on `furniture-above`, so
 * from outside it reads as one solid roofed building; TiledMapRenderer fades
 * that whole roof to ~30% alpha while a walker's anchor tile is inside the
 * shed's zone (see the `structure` zone below), so whoever is tending the
 * workbench inside stays visible instead of vanishing under it.
 *
 * Layout (relative to the door at (ox, oy+2)):
 *   (ox,oy)      ROOF_GABLE      (ox+2,oy)
 *   WALL         interior+roof   WALL
 *   WALL         DOOR (open)     WALL
 */
const pottingShed = (ox, oy) => {
  const cells = [
    [ox, oy], [ox + 1, oy], [ox + 2, oy],
    [ox, oy + 1], [ox + 1, oy + 1], [ox + 2, oy + 1],
    [ox, oy + 2], [ox + 2, oy + 2]
  ];
  for (const [x, y] of cells) claimOrThrow(x, y, 'potting-shed wall');
  claimOrThrow(ox + 1, oy + 2, 'potting-shed door');

  put(walls, ox, oy, WALL_STONE);
  put(above, ox + 1, oy, ROOF_GABLE);
  put(walls, ox + 2, oy, WALL_STONE_ALT);
  put(walls, ox, oy + 1, WALL_STONE);
  put(above, ox + 1, oy + 1, WALL_STONE); // roof directly over the interior tile
  put(walls, ox + 2, oy + 1, WALL_STONE_ALT);
  put(walls, ox, oy + 2, WALL_STONE);
  put(walls, ox + 2, oy + 2, WALL_STONE_ALT);
  put(walls, ox + 1, oy + 2, DOOR_STONE); // always visible — a hole in the roof, not a wall

  for (const [x, y] of cells) block(x, y);
  // Interior floor + doorway both stay walkable and grass-floored underneath;
  // only their `walls`/`above` art changes.

  STRUCTURES.push({ name: 'potting-shed', x: ox, y: oy, width: 3, height: 3 });
  return { interior: { x: ox + 1, y: oy + 1 }, door: { x: ox + 1, y: oy + 2 } };
};

/**
 * A small open gazebo: a wood post-and-rail frame around a one-tile sitting
 * spot, with one side left open as the entrance. No `furniture-above` tile at
 * all — there is nothing to fade, since a post frame has no mass to hide
 * anyone standing inside it in the first place.
 */
const gazebo = (ox, oy, openSide) => {
  const perimeter = [
    [ox, oy], [ox + 1, oy], [ox + 2, oy],
    [ox, oy + 1], [ox + 2, oy + 1],
    [ox, oy + 2], [ox + 1, oy + 2], [ox + 2, oy + 2]
  ];
  for (const [x, y] of perimeter) claimOrThrow(x, y, 'gazebo post');
  claimOrThrow(ox + 1, oy + 1, 'gazebo interior');

  put(walls, ox, oy, GAZEBO_TOP[0]);
  put(walls, ox + 1, oy, GAZEBO_TOP[1]);
  put(walls, ox + 2, oy, GAZEBO_TOP[2]);
  put(walls, ox, oy + 1, GAZEBO_MID[0]);
  put(walls, ox + 2, oy + 1, GAZEBO_MID[1]);
  put(walls, ox, oy + 2, GAZEBO_BOTTOM[0]);
  put(walls, ox + 1, oy + 2, GAZEBO_BOTTOM[1]);
  put(walls, ox + 2, oy + 2, GAZEBO_BOTTOM[2]);

  for (const [x, y] of perimeter) block(x, y);
  // Cut the entrance: un-block and un-paint whichever side was requested.
  const gapAt = { north: [ox + 1, oy], south: [ox + 1, oy + 2], west: [ox, oy + 1], east: [ox + 2, oy + 1] }[openSide];
  put(walls, gapAt[0], gapAt[1], 0);
  collision[idx(gapAt[0], gapAt[1])] = 0;

  return { interior: { x: ox + 1, y: oy + 1 }, gap: { x: gapAt[0], y: gapAt[1] } };
};

/** A single wishing well: WELL_BASE blocks and holds the water art, WELL_ROOF
 *  sits one row above on furniture-above using the same trunk/canopy y-sort
 *  convention trees use — open (no zone/fade), since a well is a small prop,
 *  not something anyone stands inside. Meant to sit ON an already-claimed
 *  plaza (call `plaza()` first) rather than claiming its own bare ground, so
 *  the flagstone paints straight through underneath it. */
const well = (x, y) => {
  put(below, x, y, WELL_BASE);
  put(above, x, y - 1, WELL_ROOF);
  block(x, y);
};

/** A flagstone plaza: a nine-slice paved rectangle, same edge-blend idea as
 *  DIRT, classified directly off the rectangle's own bounds rather than a
 *  neighbour scan (it's a fixed rect, not a swept path). Skips any tile
 *  already claimed (e.g. where the wide paved approach path already laid
 *  dirt right at the plaza's edge), so the two materials meet at a seam
 *  instead of one overwriting the other. */
const plaza = (x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!free(x, y)) continue;
      const row = y === y0 ? 0 : y === y1 ? 2 : 1;
      const col = x === x0 ? 0 : x === x1 ? 2 : 1;
      put(floor, x, y, STONE[row][col]);
      claim(x, y);
    }
  }
};

/** A broken stone gate: an arch you walk under. ARCH_TOP is drawn on
 *  furniture-above one row above its base, y-sorted against walkers exactly
 *  like a tree canopy (no structure zone — open, no occluding mass), so a
 *  Pokemon standing at or south of the base draws in front of the lintel. */
const ruinArch = (ox, oy) => {
  claimOrThrow(ox, oy, 'ruin arch lintel');
  claimOrThrow(ox + 1, oy, 'ruin arch lintel');
  claimOrThrow(ox, oy + 1, 'ruin arch base');
  claimOrThrow(ox + 1, oy + 1, 'ruin arch base');
  put(above, ox, oy, ARCH_TOP[0]);
  put(above, ox + 1, oy, ARCH_TOP[1]);
  put(walls, ox, oy + 1, ARCH_BASE[0]);
  put(walls, ox + 1, oy + 1, ARCH_BASE[1]);
  // Both rows stay walkable — the arch is a gate, not a wall.
};

// A rocky, sandy bank between the pond and the lawn: replaces grass with sand
// and scatters loose stones, a couple of them big enough to block.
const rockyPatch = (x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!free(x, y)) continue;
      put(floor, x, y, SAND);
      claim(x, y);
    }
  }
  let big = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (floor[idx(x, y)] !== SAND || below[idx(x, y)] !== 0) continue;
      const r = rnd();
      if (r < 0.1 && big < 2) {
        put(below, x, y, pick(ROCK));
        block(x, y);
        big++;
      } else if (r < 0.32) {
        put(below, x, y, pick(ROCK));
      }
    }
  }
};

/** A small symmetric bed of one repeated flower — the formal garden's tidy
 *  counterpart to the wild `bed()` patches, no station spawn of its own. */
const formalBed = (x0, y0, x1, y1, flowerGid) => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!free(x, y)) continue;
      const row = y === y0 ? 0 : y === y1 ? 2 : 1;
      const col = x === x0 ? 0 : x === x1 ? 2 : 1;
      put(floor, x, y, DIRT[row][col]);
      put(below, x, y, flowerGid);
      claim(x, y);
    }
  }
};

// Potting shed, tucked into a lawn pocket in the north-west (inside the
// orchard zone below — a shed among the trees). Its workbench replaces the
// outdoor stump-1 station.
const shedRooms = pottingShed(8, 10);

// A small gazebo in the north-central lawn, entered from the south. Its one
// interior tile becomes wander-4's spot — an idle Pokemon can now be found
// sitting inside it instead of standing on open grass.
const gazeboRooms = gazebo(29, 5, 'south');

// Two mirrored beds of a single bloom flank the gazebo — the formal garden.
formalBed(26, 5, 27, 6, FLOWER_BED[0]);
formalBed(32, 5, 33, 6, FLOWER_BED[0]);

// A rocky, sandy bank just south of the pond, and a broken arch leading out
// of it toward the east lawn.
rockyPatch(35, 11, 43, 13);
ruinArch(38, 14);

// The well plaza, south-east — the paved approach above already routes into
// its western edge. The well itself sits at the plaza's centre, ON the
// flagstone (plaza is painted first so the well doesn't claim bare grass).
plaza(35, 25, 41, 29);
well(38, 27);
claim(38, 27);
claim(38, 26);

// ── stations ────────────────────────────────────────────────────────────────
// Beds are flat, walkable decoration and the walker stands in them; props are
// solid, so their spawn point sits on the walkable tile in front (south) of the
// prop. TiledMapRenderer force-clears collision under a station spawn, so a
// spawn placed on a prop would put the walker inside it.
const SPAWNS = [];

/** A 3x2 planting bed: tilled soil on the floor, flowers over it. The walker
 *  tends it from the middle of its bottom row. */
const bed = (name, x, y) => {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      // Soil uses the dirt patch's own edge tiles, so the bed gets the same
      // grass-blended rim the paths do rather than a hard rectangle.
      put(floor, x + dx, y + dy, DIRT[dy === 0 ? 0 : 2][dx === 0 ? 0 : dx === 2 ? 2 : 1]);
      put(below, x + dx, y + dy, pick(FLOWER_BED));
      claim(x + dx, y + dy);
    }
  }
  SPAWNS.push({ name, x: x + 1, y: y + 1 });
};

/** A solid prop with its station on the tile below it. */
const prop = (name, gid, x, y) => {
  put(below, x, y, gid);
  block(x, y);
  claim(x, y);
  claim(x, y + 1);
  if (name) SPAWNS.push({ name, x, y: y + 1 });
};

// Planting beds, each tucked into a lawn pocket beside a walk.
bed('patch-1', 13, 19);
bed('patch-2', 14, 24);
bed('patch-3', 22, 20);
bed('patch-4', 28, 24);
bed('patch-5', 35, 20);
bed('patch-6', 24, 12);

// Felled logs — "run a command here". stump-1 moves inside the potting shed;
// its workbench sits directly on the shed's one interior tile (no "approach
// from the south" offset — there's nowhere else to stand in there).
put(below, shedRooms.interior.x, shedRooms.interior.y, WORKBENCH);
SPAWNS.push({ name: 'stump-1', x: shedRooms.interior.x, y: shedRooms.interior.y });
prop('stump-2', WORKBENCH, 31, 16);
prop('stump-3', WORKBENCH, 16, 15);

// Where a walker waits on you. signpost-1 moves beside the well — "blocked on
// you" now reads as waiting at the wishing well instead of out on the lawn.
prop('signpost-1', SIGNPOST, 40, 27);
prop('mailbox-1', MAILBOX, 20, 12);

// The pond is solid, so most of its stations sit on the sand rim.
for (const [name, x, y] of [
  ['pond-1', 37, 10],
  ['pond-2', 38, 3],
  ['pond-3', 42, 3]
]) {
  SPAWNS.push({ name, x, y });
  claim(x, y);
}

// One station on an island in the middle of the water, reachable only from the
// air. This is what makes a flying Pokemon's locomotion actually visible: the
// pond is a convex rectangle, so on a 4-connected grid walking around it costs
// exactly what crossing it would, and a flier given a shore destination would
// never have reason to leave the ground. An island forces the difference.
const ISLAND = {
  x: PONDR.x0 + Math.floor((PONDR.x1 - PONDR.x0) / 2),
  y: PONDR.y0 + Math.floor((PONDR.y1 - PONDR.y0) / 2)
};
put(floor, ISLAND.x, ISLAND.y, POND_ISLAND);
collision[idx(ISLAND.x, ISLAND.y)] = 0;
water[idx(ISLAND.x, ISLAND.y)] = 0; // land, so a flier can stand on it
SPAWNS.push({ name: 'pond-island', x: ISLAND.x, y: ISLAND.y });
claim(ISLAND.x, ISLAND.y);

/** Spawns a walking Pokemon is not expected to reach. Must match
 *  stations.ts's AIR_ONLY_SPAWNS. */
const AIR_ONLY = new Set(['pond-island']);

// Idle strolling spots: open lawn a session loiters around when it has no
// work. wander-4 now sits inside the gazebo instead of on bare grass.
const WANDER = [
  { name: 'wander-1', x: 6, y: 8 },
  { name: 'wander-2', x: 8, y: 28 },
  { name: 'wander-3', x: 42, y: 16 },
  { name: 'wander-4', x: gazeboRooms.interior.x, y: gazeboRooms.interior.y }
];
for (const w of WANDER) {
  SPAWNS.push(w);
  claim(w.x, w.y);
}
claim(gazeboRooms.gap.x, gazeboRooms.gap.y);

SPAWNS.push({ name: 'entrance', x: 23, y: 30 });
claim(23, 30);

// A couple of non-station props for flavour, next to the stations they dress.
prop(null, CRATE, 19, 24);
prop(null, BEEHIVE, 38, 20);

// Reeds on the sand rim, so the pond does not read as a rectangle in a rectangle.
// The rim is `claim`ed, so the scatter pass below skips it; this dresses it
// explicitly, keeping every rim tile walkable (a station sits on the south shore).
for (let y = PONDR.y0 - 1; y <= PONDR.y1 + 1; y++) {
  for (let x = PONDR.x0 - 1; x <= PONDR.x1 + 1; x++) {
    if (inPond(x, y) || !inside(x, y) || below[idx(x, y)] !== 0) continue;
    const onRim =
      x === PONDR.x0 - 1 || x === PONDR.x1 + 1 || y === PONDR.y0 - 1 || y === PONDR.y1 + 1;
    if (!onRim || rnd() > 0.45) continue;
    put(below, x, y, rnd() < 0.6 ? pick(GRASS_TUFT) : SHRUB);
  }
}

// ── zones (region rects, defined here so the tree/scatter passes below can
// vary density and layout by area they fall in) ────────────────────────────
const MEADOW_ZONE = { x: 1, y: 19, width: 20, height: 12 };
const ORCHARD_ZONE = { x: 1, y: 1, width: 20, height: 14 };
const inZone = (z, x, y) => x >= z.x && x < z.x + z.width && y >= z.y && y < z.y + z.height;

// ── orchard: deliberate tree rows, in contrast to the naturalistic jitter
// everywhere else ────────────────────────────────────────────────────────────
// The general TREES pass below explicitly skips this zone, so its rows stay
// crisp instead of getting diluted by stray jittered trees in the gaps.
let orchardTreeCount = 0;
for (let gy = ORCHARD_ZONE.y + 2; gy < ORCHARD_ZONE.y + ORCHARD_ZONE.height - 1; gy += 3) {
  for (let gx = ORCHARD_ZONE.x + 2; gx < ORCHARD_ZONE.x + ORCHARD_ZONE.width - 1; gx += 3) {
    if (!free(gx, gy) || !free(gx, gy - 1)) continue;
    const variant = rnd() < 0.2 ? 1 : 0;
    put(above, gx, gy - 1, TREE_CANOPY[variant]);
    put(below, gx, gy, TREE_TRUNK[variant]);
    block(gx, gy);
    claim(gx, gy);
    claim(gx, gy - 1);
    orchardTreeCount++;
  }
}

// ── trees: canopy on furniture-above so walkers pass behind the foliage ─────
// Only the trunk blocks; the canopy tile stays walkable, which is the whole
// point of the split.
//
// Positions are jittered off a coarse lattice rather than listed: an evenly
// spaced list reads as an orchard grid from a distance, which the rest of the
// garden should not (the actual orchard, above, earns that look on purpose).
// The lattice guarantees coverage, the jitter kills the rows.
const TREES = [];
for (let gy = 3; gy < H - 3; gy += 4) {
  for (let gx = 3; gx < W - 3; gx += 4) {
    if (inZone(ORCHARD_ZONE, gx, gy)) continue; // that zone plants its own rows
    if (rnd() < 0.28) continue; // gaps, so the canopy never closes into a wall
    TREES.push([gx + Math.floor(rnd() * 3) - 1, gy + Math.floor(rnd() * 3) - 1]);
  }
}
let treeCount = orchardTreeCount;
for (const [x, y] of TREES) {
  if (!free(x, y) || !free(x, y - 1)) continue;
  const variant = rnd() < 0.25 ? 1 : 0;
  put(above, x, y - 1, TREE_CANOPY[variant]);
  put(below, x, y, TREE_TRUNK[variant]);
  block(x, y);
  claim(x, y);
  claim(x, y - 1);
  treeCount++;
}

// ── scattered ground detail ─────────────────────────────────────────────────
// Density and mix vary by region: the meadow runs wild (dense flowers and
// tufted grass), the orchard stays sparse underfoot so its tree rows read
// clearly, and everywhere else keeps the original light scatter.
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    if (!free(x, y)) continue;
    const inMeadow = inZone(MEADOW_ZONE, x, y);
    const inOrchard = inZone(ORCHARD_ZONE, x, y);
    const r = rnd();
    if (inOrchard) {
      // Bare grass between the rows, with just an occasional tuft — a mown
      // orchard floor, not a second layer of undergrowth competing with it.
      if (r < 0.06) put(below, x, y, pick(GRASS_TUFT));
      continue;
    }
    if (inMeadow) {
      // Dense, uncultivated growth: mostly flowers and tall grass, with the
      // odd bush, and none of the sparse "stray wildflower" restraint the
      // rest of the lawn uses.
      if (r < 0.02) {
        put(below, x, y, BUSH);
        block(x, y);
        claim(x, y);
      } else if (r < 0.4) {
        put(below, x, y, pick(FLOWER_BED));
      } else if (r < 0.75) {
        put(below, x, y, pick(GRASS_TUFT));
      } else if (r < 0.8) {
        put(below, x, y, MUSHROOMS);
      }
      continue;
    }
    if (r < 0.03) {
      put(below, x, y, BUSH); // solid
      block(x, y);
      claim(x, y);
    } else if (r < 0.042) {
      put(below, x, y, SMALL_TREE);
      block(x, y);
      claim(x, y);
    } else if (r < 0.075) {
      put(below, x, y, pick(GRASS_TUFT));
    } else if (r < 0.09) {
      put(below, x, y, SHRUB);
    } else if (r < 0.098) {
      put(below, x, y, MUSHROOMS);
    } else if (r < 0.108) {
      put(below, x, y, pick(FLOWER_BED)); // stray wildflowers on the lawn
    }
  }
}

// ── every station tile must be reachable ────────────────────────────────────
// findPath() early-returns null (silently) when the GOAL tile is unwalkable, so
// a walker would simply never move. Clear collision on each spawn and on the
// gate, and sanity-check that nothing solid was scattered onto one.
for (const s of SPAWNS) {
  collision[idx(s.x, s.y)] = 0;
  if (below[idx(s.x, s.y)] === BUSH || below[idx(s.x, s.y)] === SMALL_TREE) {
    throw new Error(`spawn ${s.name} landed under a solid prop`);
  }
}
for (const x of GATE) collision[idx(x, H - 1)] = 0;
// The structures' own walkable tiles (doorways, arch, gazebo gap) that aren't
// already a station spawn — asserted below by name for a clear failure.
const EXTRA_REACHABLE = [
  { name: 'potting-shed door', x: shedRooms.door.x, y: shedRooms.door.y },
  { name: 'ruin arch (west)', x: 38, y: 15 },
  { name: 'ruin arch (east)', x: 39, y: 15 }
];

// ── flood fill from the entrance: no station may be walled off ──────────────
{
  const entrance = SPAWNS.find((s) => s.name === 'entrance');
  const seen = Array.from({ length: H }, () => new Array(W).fill(false));
  const queue = [[entrance.x, entrance.y]];
  seen[entrance.y][entrance.x] = true;
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny) || seen[ny][nx] || collision[idx(nx, ny)] !== 0) continue;
      seen[ny][nx] = true;
      queue.push([nx, ny]);
    }
  }
  for (const s of SPAWNS) {
    const reachable = seen[s.y][s.x];
    // Air-only spawns must be unreachable on foot — that is the whole point of
    // them — and every other spawn must be reachable. Both directions are
    // asserted, so the island cannot silently become walkable either.
    if (AIR_ONLY.has(s.name)) {
      if (reachable) throw new Error(`air-only spawn ${s.name} is reachable on foot`);
    } else if (!reachable) {
      throw new Error(`spawn ${s.name} at ${s.x},${s.y} is unreachable`);
    }
  }
  for (const e of EXTRA_REACHABLE) {
    if (!seen[e.y][e.x]) throw new Error(`${e.name} at ${e.x},${e.y} is unreachable`);
  }
}

// ── open-lawn budget: printed below, not enforced — a spot-check that the new
// structures/regions didn't leave the map as one big undifferentiated field.
// Two numbers: plain walkable grass anywhere (the literal "room to roam"), and
// the same restricted to tiles outside every named region/structure zone —
// the part of the map that is still genuinely unthemed lawn, which is what
// the 25-35% target is really about. ─────────────────────────────────────────
const NAMED_ZONES = [MEADOW_ZONE, ORCHARD_ZONE, { x: 35, y: 11, width: 9, height: 3 }, { x: 35, y: 25, width: 7, height: 5 }, { x: 26, y: 4, width: 8, height: 4 }, { x: 29, y: 5, width: 3, height: 3 }, ...STRUCTURES];
let openLawnTiles = 0;
let unthemedLawnTiles = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!GRASS.includes(floor[idx(x, y)]) || collision[idx(x, y)] !== 0) continue;
    openLawnTiles++;
    if (!NAMED_ZONES.some((z) => inZone(z, x, y))) unthemedLawnTiles++;
  }
}
const openLawnPct = ((openLawnTiles / (W * H)) * 100).toFixed(1);
const unthemedLawnPct = ((unthemedLawnTiles / (W * H)) * 100).toFixed(1);

// ── tileset defs, with Tiled animations on every water tile actually used ───
const usedPondTiles = new Set();
for (const gid of floor) if (POND_TILES.includes(gid)) usedPondTiles.add(gid);

const tilesets = TS.tilesets.map((t, i) => {
  const def = {
    firstgid: FIRSTGID[i],
    name: t.name,
    image: t.image,
    imagewidth: t.imagewidth,
    imageheight: t.imageheight,
    tilewidth: T,
    tileheight: T,
    columns: t.columns,
    tilecount: t.tilecount,
    margin: 0,
    spacing: 0
  };
  if (i !== POND) return def;
  def.tiles = [...usedPondTiles]
    .sort((a, b) => a - b)
    .map((gid) => {
      const local = gid - FIRSTGID[POND];
      const blockId = (local % t.columns) % A.blockCols + Math.floor(local / t.columns) * A.blockCols;
      return {
        id: local,
        animation: Array.from({ length: A.frames }, (_, frame) => ({
          tileid: pondLocal(blockId, frame),
          duration: A.durationMs
        }))
      };
    });
  return def;
});

// ── assemble ────────────────────────────────────────────────────────────────
const tileLayer = (name, data, id) => ({
  id,
  name,
  type: 'tilelayer',
  width: W,
  height: H,
  x: 0,
  y: 0,
  opacity: 1,
  visible: true,
  data
});

const ZONES = [
  { name: 'meadow', x: MEADOW_ZONE.x, y: MEADOW_ZONE.y, width: MEADOW_ZONE.width, height: MEADOW_ZONE.height },
  { name: 'pond', x: PONDR.x0 - 1, y: PONDR.y0 - 1, width: PONDR.x1 - PONDR.x0 + 3, height: PONDR.y1 - PONDR.y0 + 3 },
  { name: 'orchard', x: ORCHARD_ZONE.x, y: ORCHARD_ZONE.y, width: ORCHARD_ZONE.width, height: ORCHARD_ZONE.height },
  { name: 'gate', x: 21, y: 24, width: 5, height: 7 },
  { name: 'rock-garden', x: 35, y: 11, width: 9, height: 3 },
  { name: 'well-plaza', x: 35, y: 25, width: 7, height: 5 },
  { name: 'formal-garden', x: 26, y: 4, width: 8, height: 4 },
  // `type: 'structure'` is the only zone type TiledMapRenderer treats
  // specially: it groups that structure's furniture-above tiles into one
  // fading roof. Every other zone above is purely informational.
  ...STRUCTURES.map((s) => ({ ...s, type: 'structure' }))
];

const map = {
  compressionlevel: -1,
  width: W,
  height: H,
  tilewidth: T,
  tileheight: T,
  infinite: false,
  orientation: 'orthogonal',
  renderorder: 'right-down',
  type: 'map',
  version: '1.10',
  tiledversion: '1.10.2',
  nextlayerid: 9,
  nextobjectid: 100 + SPAWNS.length + ZONES.length,
  tilesets,
  layers: [
    tileLayer('floor', floor, 1),
    tileLayer('walls', walls, 2),
    tileLayer('furniture-below', below, 3),
    tileLayer('furniture-above', above, 4),
    { ...tileLayer('collision', collision, 5), visible: false },
    { ...tileLayer('water', water, 8), visible: false },
    {
      id: 6,
      name: 'spawn-points',
      type: 'objectgroup',
      draworder: 'topdown',
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
      objects: SPAWNS.map((s, i) => ({
        id: 100 + i,
        name: s.name,
        type: '',
        point: true,
        x: s.x * T,
        y: s.y * T,
        width: 0,
        height: 0,
        rotation: 0,
        visible: true
      }))
    },
    {
      id: 7,
      name: 'zones',
      type: 'objectgroup',
      draworder: 'topdown',
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
      objects: ZONES.map((z, i) => ({
        id: 200 + i,
        name: z.name,
        type: z.type ?? '',
        x: z.x * T,
        y: z.y * T,
        width: z.width * T,
        height: z.height * T,
        rotation: 0,
        visible: true
      }))
    }
  ]
};

const out = join(MAPS_DIR, 'garden.tmj');
writeFileSync(out, JSON.stringify(map, null, 1) + '\n');
console.log(
  `[gen-garden-map] wrote ${out} — ${W}x${H}, ${SPAWNS.length} spawn points, ` +
    `${treeCount} trees (${orchardTreeCount} in the orchard rows), ` +
    `${usedPondTiles.size} animated water tiles, ${STRUCTURES.length} enclosed structures, ` +
    `${openLawnPct}% open walkable lawn (${unthemedLawnPct}% of that outside any named region)`
);
