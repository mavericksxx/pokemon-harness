#!/usr/bin/env node
'use strict';
/**
 * Generate the PLACEHOLDER garden map (`src/renderer/src/scene/garden/maps/garden.tmj`).
 *
 * This exists only until real Tiled-authored garden art lands. The output is a
 * standard Tiled .tmj using the layer convention munder-difflin / the-office use:
 *
 *   tile layers:   floor, walls, furniture-below, furniture-above, collision
 *   object groups: spawn-points, zones
 *
 * Swapping in a real map later is a pure data change: drop a new .tmj next to
 * this one and point `garden.tmj` at it (plus a real tileset PNG — see
 * placeholderArt.ts). Nothing in the renderer knows these tiles were generated.
 *
 * Tile metadata is read from placeholderTileset.json so the map's gid layout and
 * the runtime canvas painter can never drift apart.
 */
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const MAPS_DIR = join(__dirname, '..', 'src', 'renderer', 'src', 'scene', 'garden', 'maps');
const TS = JSON.parse(readFileSync(join(MAPS_DIR, 'placeholderTileset.json'), 'utf8'));

const W = 34;
const H = 22;
const T = TS.tilewidth;

// firstgid is 1, so gid = localId + 1.
const GID = Object.fromEntries(TS.tiles.map((t) => [t.key, t.id + 1]));

// Deterministic PRNG so regenerating the map produces byte-identical output.
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const blank = () => new Array(W * H).fill(0);
const idx = (x, y) => y * W + x;
const put = (layer, x, y, gid) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  layer[idx(x, y)] = gid;
};

const floor = blank();
const walls = blank();
const below = blank();
const above = blank();
const collision = blank();

// ── floor: grass with a sprinkling of a second grass tile ──────────────────
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    put(floor, x, y, rnd() < 0.14 ? GID['grass-alt'] : GID.grass);
  }
}

// ── paths ──────────────────────────────────────────────────────────────────
const PATH_ROWS = [{ y: 11, x0: 2, x1: 31 }];
const PATH_COLS = [
  { x: 6, y0: 3, y1: 18 },
  { x: 14, y0: 3, y1: 18 },
  { x: 22, y0: 11, y1: 18 }
];
for (const r of PATH_ROWS) for (let x = r.x0; x <= r.x1; x++) put(floor, x, r.y, GID.path);
for (const c of PATH_COLS) for (let y = c.y0; y <= c.y1; y++) put(floor, c.x, y, GID.path);
// A ring of path-edge tiles so the paths read as paths and not as stripes.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (floor[idx(x, y)] !== GID.path) continue;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      const g = floor[idx(nx, ny)];
      if (g === GID.grass || g === GID['grass-alt']) put(floor, nx, ny, GID['path-edge']);
    }
  }
}

// ── pond ───────────────────────────────────────────────────────────────────
const POND = { x0: 25, y0: 3, x1: 30, y1: 8 };
for (let y = POND.y0; y <= POND.y1; y++) {
  for (let x = POND.x0; x <= POND.x1; x++) {
    const deep = x > POND.x0 && x < POND.x1 && y > POND.y0 && y < POND.y1;
    put(floor, x, y, deep ? GID['water-deep'] : GID.water);
    put(collision, x, y, GID.block);
  }
}

// ── walls: a hedge around the whole garden ─────────────────────────────────
for (let x = 0; x < W; x++) {
  put(walls, x, 0, GID.hedge);
  put(walls, x, H - 1, GID.hedge);
}
for (let y = 0; y < H; y++) {
  put(walls, 0, y, GID.hedge);
  put(walls, W - 1, y, GID.hedge);
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (walls[idx(x, y)] !== 0) put(collision, x, y, GID.block);
  }
}

// ── spawn points (tile coords; converted to Tiled pixel coords below) ──────
const SPAWNS = [
  { name: 'patch-1', x: 5, y: 4 },
  { name: 'patch-2', x: 7, y: 4 },
  { name: 'patch-3', x: 13, y: 4 },
  { name: 'patch-4', x: 15, y: 4 },
  { name: 'patch-5', x: 5, y: 18 },
  { name: 'patch-6', x: 13, y: 18 },
  { name: 'pond-1', x: 24, y: 6 },
  { name: 'signpost-1', x: 18, y: 11 },
  { name: 'entrance', x: 2, y: 11 }
];

// Flower beds mark every patch station; the signpost stands just north of its tile.
for (const s of SPAWNS) {
  if (s.name.startsWith('patch-')) put(below, s.x, s.y, GID.flowers);
}
put(below, 18, 10, GID.signpost);
put(collision, 18, 10, GID.block);

// Decorative stones (no collision).
for (const [x, y] of [[9, 12], [25, 12], [17, 17], [10, 5]]) put(below, x, y, GID.stone);

// ── trees (drawn above characters, and solid) ──────────────────────────────
const TREES = [[3, 6], [10, 8], [10, 15], [19, 6], [28, 15], [31, 17], [3, 15], [20, 16]];
for (const [x, y] of TREES) {
  put(above, x, y, GID.tree);
  put(collision, x, y, GID.block);
}

// ── every spawn tile must be reachable ─────────────────────────────────────
// findPath() early-returns null when the GOAL tile is unwalkable, and it does so
// silently — a walker would simply never move. Clear collision on each spawn.
for (const s of SPAWNS) collision[idx(s.x, s.y)] = 0;

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
  nextobjectid: 32,
  tilesets: [
    {
      firstgid: 1,
      name: TS.name,
      image: TS.image,
      imagewidth: TS.imagewidth,
      imageheight: TS.imageheight,
      tilewidth: TS.tilewidth,
      tileheight: TS.tileheight,
      columns: TS.columns,
      tilecount: TS.tilecount,
      margin: 0,
      spacing: 0
    }
  ],
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
      objects: [
        { name: 'meadow', x: 1, y: 1, width: 20, height: 20 },
        { name: 'pond', x: POND.x0 - 1, y: POND.y0 - 1, width: POND.x1 - POND.x0 + 3, height: POND.y1 - POND.y0 + 3 },
        { name: 'crossroads', x: 16, y: 9, width: 6, height: 5 }
      ].map((z, i) => ({
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
console.log(`[gen-placeholder-map] wrote ${out} (${W}x${H}, ${SPAWNS.length} spawn points)`);
