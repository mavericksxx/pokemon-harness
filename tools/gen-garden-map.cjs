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
// Kenney Tiny Town (192x176, 12 cols). Ids read off the sheet by inspection.
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

// OGA "mostly flowers" (1024x207, 64 cols). Row 0 is the bloomed stage.
const FLOWER_BED = [f(25), f(29), f(31), f(34), f(36), f(39)];
const GRASS_TUFT = [f(273), f(274), f(275), f(20), f(21)];

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
const POND_TILES = [POND_NW, POND_N, POND_NE, POND_W, ...POND_C, POND_E, POND_SW, POND_S, POND_SE];

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

const isPath = Array.from({ length: H }, () => new Array(W).fill(false));
/** Tiles claimed by paths / pond / beds / props, so scatter never lands on them. */
const claimed = Array.from({ length: H }, () => new Array(W).fill(false));
const claim = (x, y) => {
  if (inside(x, y)) claimed[y][x] = true;
};
const free = (x, y) => inside(x, y) && !claimed[y][x];

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
// `route` walks a polyline whose points are the top-left corner of the 2x2 band.
const PATH_W = 2;
const route = (pts) => {
  for (let i = 0; i < pts.length - 1; i++) {
    let [x, y] = pts[i];
    const [tx, ty] = pts[i + 1];
    if (x !== tx && y !== ty) throw new Error(`route segment ${i} is not axis-aligned`);
    const dx = Math.sign(tx - x);
    const dy = Math.sign(ty - y);
    for (;;) {
      for (let a = 0; a < PATH_W; a++) {
        for (let b = 0; b < PATH_W; b++) if (inside(x + a, y + b)) isPath[y + b][x + a] = true;
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
route([[23, 26], [34, 26], [34, 29]]); // south-east spur

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

// Felled logs — "run a command here".
prop('stump-1', WORKBENCH, 20, 24);
prop('stump-2', WORKBENCH, 31, 16);
prop('stump-3', WORKBENCH, 16, 15);

// Where a walker waits on you.
prop('signpost-1', SIGNPOST, 25, 28);
prop('mailbox-1', MAILBOX, 20, 12);

// The pond is solid, so its stations sit on the sand rim along its south shore.
for (const [name, x, y] of [
  ['pond-1', 37, 10],
  ['pond-2', 41, 10]
]) {
  SPAWNS.push({ name, x, y });
  claim(x, y);
}

// Idle strolling spots: open lawn a session loiters around when it has no work.
const WANDER = [
  { name: 'wander-1', x: 6, y: 8 },
  { name: 'wander-2', x: 8, y: 28 },
  { name: 'wander-3', x: 42, y: 16 },
  { name: 'wander-4', x: 30, y: 6 }
];
for (const w of WANDER) {
  SPAWNS.push(w);
  claim(w.x, w.y);
}

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

// ── trees: canopy on furniture-above so walkers pass behind the foliage ─────
// Only the trunk blocks; the canopy tile stays walkable, which is the whole
// point of the split.
//
// Positions are jittered off a coarse lattice rather than listed: an evenly
// spaced list reads as an orchard grid from a distance, which a garden should
// not. The lattice guarantees coverage, the jitter kills the rows.
const TREES = [];
for (let gy = 3; gy < H - 3; gy += 4) {
  for (let gx = 3; gx < W - 3; gx += 4) {
    if (rnd() < 0.28) continue; // gaps, so the canopy never closes into a wall
    TREES.push([gx + Math.floor(rnd() * 3) - 1, gy + Math.floor(rnd() * 3) - 1]);
  }
}
let treeCount = 0;
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
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    if (!free(x, y)) continue;
    const r = rnd();
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
    if (!seen[s.y][s.x]) throw new Error(`spawn ${s.name} at ${s.x},${s.y} is unreachable`);
  }
}

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
  { name: 'meadow', x: 1, y: 19, width: 20, height: 12 },
  { name: 'pond', x: PONDR.x0 - 1, y: PONDR.y0 - 1, width: PONDR.x1 - PONDR.x0 + 3, height: PONDR.y1 - PONDR.y0 + 3 },
  { name: 'orchard', x: 1, y: 1, width: 20, height: 14 },
  { name: 'gate', x: 21, y: 24, width: 5, height: 7 }
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
  nextlayerid: 8,
  nextobjectid: 100 + SPAWNS.length + ZONES.length,
  tilesets,
  layers: [
    tileLayer('floor', floor, 1),
    tileLayer('walls', walls, 2),
    tileLayer('furniture-below', below, 3),
    tileLayer('furniture-above', above, 4),
    { ...tileLayer('collision', collision, 5), visible: false },
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
        type: '',
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
    `${treeCount} trees, ${usedPondTiles.size} animated water tiles`
);
