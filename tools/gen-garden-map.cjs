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
const WORKBENCH = k(106); // a felled log — the "run a command here" station
const CRATE = k(107);
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

// ── paths: a 2-tile-wide loop from the gate, plus the pond's sandy bank ─────
// Kenney's dirt is a 3x3 patch with grass-blended edges and no inner-corner
// tiles, so paths are kept 2 wide: every cell then has grass on exactly one of
// each axis and lands on a real edge tile. Junctions get the plain centre tile.
const PATH_RECTS = [
  { x0: 23, y0: 18, x1: 24, y1: 30 }, // gate spine
  { x0: 8, y0: 17, x1: 24, y1: 18 }, // west promenade
  { x0: 8, y0: 10, x1: 9, y1: 18 }, // north-west vertical
  { x0: 8, y0: 10, x1: 40, y1: 11 }, // north walk, running along the pond bank
  { x0: 39, y0: 11, x1: 40, y1: 26 }, // east vertical
  { x0: 23, y0: 25, x1: 40, y1: 26 } // south walk, closing the loop
];
const PONDR = { x0: 30, y0: 3, x1: 39, y1: 9 };
const inPond = (x, y) => x >= PONDR.x0 && x <= PONDR.x1 && y >= PONDR.y0 && y <= PONDR.y1;

for (const r of PATH_RECTS) {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (inside(x, y)) isPath[y][x] = true;
}
// A one-tile sand bank rings the pond, so the water never abuts raw grass — the
// pond sheet's greens are a shade yellower than Kenney's and the joint shows.
for (let y = PONDR.y0 - 1; y <= PONDR.y1 + 1; y++) {
  for (let x = PONDR.x0 - 1; x <= PONDR.x1 + 1; x++) {
    if (inside(x, y) && !inPond(x, y)) isPath[y][x] = true;
  }
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isPath[y][x]) continue;
    // The pond counts as "path" for edging purposes, so the bank blends into the
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

/** A 3x2 flower bed; the walker tends it from the middle of its bottom row. */
const bed = (name, x, y) => {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 3; dx++) {
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

bed('patch-1', 11, 13);
bed('patch-2', 15, 13);
bed('patch-3', 11, 20);
bed('patch-4', 15, 20);
bed('patch-5', 28, 21);
bed('patch-6', 32, 21);

prop('stump-1', WORKBENCH, 20, 20);
prop('stump-2', WORKBENCH, 27, 14);
prop('signpost-1', SIGNPOST, 22, 16);

// The pond is solid, so its stations sit on the sand bank along its south shore.
for (const [name, x, y] of [
  ['pond-1', 33, 10],
  ['pond-2', 36, 10]
]) {
  SPAWNS.push({ name, x, y });
  claim(x, y);
}

// Idle strolling spots: open lawn a session loiters around when it has no work.
const WANDER = [
  { name: 'wander-1', x: 4, y: 6 },
  { name: 'wander-2', x: 14, y: 28 },
  { name: 'wander-3', x: 34, y: 17 },
  { name: 'wander-4', x: 44, y: 20 }
];
for (const w of WANDER) {
  SPAWNS.push(w);
  claim(w.x, w.y);
}

SPAWNS.push({ name: 'entrance', x: 23, y: 30 });
claim(23, 30);

// A couple of non-station props for flavour, next to the stations they dress.
prop(null, CRATE, 19, 20);
prop(null, BEEHIVE, 35, 21);

// ── trees: canopy on furniture-above so walkers pass behind the foliage ─────
// Only the trunk blocks; the canopy tile stays walkable, which is the whole
// point of the split.
const TREES = [];
// An orchard hedge just inside the fence, with gaps so it never reads as a wall.
for (let x = 2; x < W - 2; x += 3) {
  TREES.push([x, 2], [x + 1, H - 3]);
}
for (let y = 4; y < H - 3; y += 3) {
  TREES.push([2, y], [W - 3, y + 1]);
}
// Interior clusters, framing the lawns the stations sit in.
TREES.push(
  [5, 14], [6, 21], [5, 25], [12, 6], [16, 6], [20, 5], [24, 6], [27, 6],
  [13, 24], [17, 24], [20, 27], [28, 28], [32, 28], [36, 28],
  [26, 18], [30, 17], [37, 16], [44, 14], [44, 24], [12, 17], [16, 17]
);
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
    if (r < 0.035) {
      put(below, x, y, BUSH); // solid
      block(x, y);
      claim(x, y);
    } else if (r < 0.05) {
      put(below, x, y, SMALL_TREE);
      block(x, y);
      claim(x, y);
    } else if (r < 0.075) {
      put(below, x, y, pick(GRASS_TUFT));
    } else if (r < 0.085) {
      put(below, x, y, SHRUB);
    } else if (r < 0.092) {
      put(below, x, y, MUSHROOMS);
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
