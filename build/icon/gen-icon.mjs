// Pokéharness app icon — production generator.
//
// Based on the user-approved mockup recipe (round 4 of the icon-mockup
// exploration, candidate 35): a real Pokemon Showdown Garchomp sprite
// (assets/garchomp-front.png, 96x96, gen5 static front sheet) centered on a
// 128-unit grid, deep-indigo ground with three dithered nebula clusters, a
// sparse gold star field, and a solid gold ">" caret top-left — the same
// drawing primitives (Float64Array pixel grid, hand-rolled zlib PNG
// encoder, nearest-neighbor upscale / box-average downscale) as the mockup
// toolkit it's ported from.
//
// Full-bleed background: the ground fills the entire square canvas
// edge-to-edge with no drawn corner rounding and no transparent margin.
// macOS applies its own squircle mask to Dock/Finder icons; a rounded tile
// drawn inside a square canvas leaves a transparent margin between the
// artwork's own rounded corners and the system mask's corners, and on
// recent macOS that transparent margin gets composited onto the system's
// light icon backing plate — showing up as a light/white ring around the
// tile. Filling the whole canvas removes that margin entirely. Contents
// (sprite + caret) are kept inset within the ~80% "safe area" Apple's own
// icon guidelines use, so nothing sits close enough to a true corner to be
// clipped by the mask.
//
// Why re-derive every size from the 128-unit grid instead of downscaling
// the 1024/512 master: box-downsampling a flattened, already-composited PNG
// compounds two resamples (art -> 512 -> 16) and the mockup rounds found
// the caret/sprite footprint gets soft at 16px when that shortcut is taken.
// Rendering each target size directly from the 128-unit source (backdrop
// redrawn at the exact target scale; sprite resized straight from its own
// 96x96 original with a matched filter) keeps every size a single resample
// from source, so the caret and sprite hold the legible footprint the
// mockup sheets validated down to 16px — nebula texture is the one thing
// deliberately allowed to soften away first (it's flat dithered color, not
// a shape the icon depends on for recognizability).
//
// Requires on PATH: `magick` (ImageMagick — sprite resize/composite) and
// `iconutil` (macOS-only — .iconset -> .icns). Both are one-time build
// tools, not app runtime dependencies (same category as gen-garden-map.cjs
// needing Tiled-authored input, not a new npm package).
//
// Run: node build/icon/gen-icon.mjs
// Writes build/icon.icns (mac icon, wired into electron-builder),
// build/icon/icon.png (512px, for the non-mac BrowserWindow icon option),
// and build/icon/icon-1024.png (1024px master, consumed by
// gen-tahoe-icon.mjs for the macOS 26 Tahoe Assets.car asset).

import { execSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SPRITE = join(HERE, 'assets', 'garchomp-front.png');
const TMP = join(HERE, '_tmp');
const ICONSET = join(HERE, '_tmp', 'icon.iconset');

function sh(cmd) {
  execSync(cmd, { stdio: 'pipe' });
}

// ---------- pixel grid + drawing primitives (subset of the mockup toolkit) ----------

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function makeGrid(w, h) {
  return { w, h, data: new Float64Array(w * h * 4) };
}

function blend(grid, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
  const i = (y * grid.w + x) * 4;
  const A = a / 255;
  const d = grid.data;
  d[i] = d[i] * (1 - A) + r * A;
  d[i + 1] = d[i + 1] * (1 - A) + g * A;
  d[i + 2] = d[i + 2] * (1 - A) + b * A;
  d[i + 3] = d[i + 3] * (1 - A) + a * A;
}

function stampMask(grid, ox, oy, mask, color, alpha = 255, scale = 1) {
  const [r, g, b] = hex(color);
  for (let row = 0; row < mask.length; row++) {
    for (let c = 0; c < mask[row].length; c++) {
      if (mask[row][c] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          blend(grid, ox + c * scale + dx, oy + row * scale + dy, [r, g, b, alpha]);
        }
      }
    }
  }
}

function fillRect(grid, x0, y0, x1, y1, color, alpha = 255) {
  const [r, g, b] = hex(color);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) blend(grid, x, y, [r, g, b, alpha]);
  }
}

function nearestUpscale(grid, factor) {
  const w = grid.w * factor, h = grid.h * factor;
  const out = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < w; x++) {
      const sx = (x / factor) | 0;
      const si = (sy * grid.w + sx) * 4, di = (y * w + x) * 4;
      out.data[di] = grid.data[si];
      out.data[di + 1] = grid.data[si + 1];
      out.data[di + 2] = grid.data[si + 2];
      out.data[di + 3] = grid.data[si + 3];
    }
  }
  return out;
}

function boxDownscale(grid, factor) {
  const w = grid.w / factor, h = grid.h / factor;
  const out = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const si = ((y * factor + dy) * grid.w + (x * factor + dx)) * 4;
          const alpha = grid.data[si + 3] / 255;
          r += grid.data[si] * alpha;
          g += grid.data[si + 1] * alpha;
          b += grid.data[si + 2] * alpha;
          a += grid.data[si + 3];
        }
      }
      const n = factor * factor;
      const alphaSum = a / 255;
      const di = (y * w + x) * 4;
      if (alphaSum > 0) {
        out.data[di] = r / alphaSum;
        out.data[di + 1] = g / alphaSum;
        out.data[di + 2] = b / alphaSum;
      }
      out.data[di + 3] = a / n;
    }
  }
  return out;
}

// ---------- PNG encoding (pure zlib, no image deps) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function encodePNG(grid) {
  const { w, h, data } = grid;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = rowStart + 1 + x * 4;
      raw[di] = clamp8(data[si]);
      raw[di + 1] = clamp8(data[si + 1]);
      raw[di + 2] = clamp8(data[si + 2]);
      raw[di + 3] = clamp8(data[si + 3]);
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function savePNG(grid, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePNG(grid));
}

// ---------- candidate-35 recipe (round4.mjs), adapted for a full-bleed background ----------

const P = { gold: '#E8B740' };
const GROUND = '#171233';
const BASE4 = 128;
// Apple's icon guidelines treat the middle ~80% of the canvas as the safe
// area a squircle mask won't clip — roughly a 10%-per-side inset. SAFE4 is
// that inset on the 128-unit grid; the caret is anchored to it (kept
// top-left, just pulled in from the true corner) so the corner crop can't
// clip it. Kept as a multiple of CARET_SOLID (4) rather than the exact 12.8
// so the caret's cell grid stays phase-aligned with the box-downscale
// factors used for the smaller icon sizes (2/4/8) instead of straddling
// them at an arbitrary offset — checked against the sprite art that it
// still clears the sprite's actual ink, not just its bounding box.
const SAFE4 = 12;
const CARET_XY4 = [SAFE4, SAFE4];
const CARET_SOLID = 4; // stamp scale — see round4.mjs's comment on the proven legibility floor
const CARET_MASK = [
  '0000000',
  '0100000',
  '0010000',
  '0001100',
  '0010000',
  '0100000',
  '0000000'
];
const NEBULA_CLUSTERS = [
  { cx: 30, cy: 90, r: 30, color: '#7A2E6E', seed: 2, density: 0.45 },
  { cx: 95, cy: 35, r: 26, color: '#5A3A9E', seed: 5, density: 0.4 },
  { cx: 100, cy: 100, r: 22, color: '#8C3AA0', seed: 9, density: 0.35 }
];
const STAR_SEED = 11;
const STAR_COUNT = 8;
// BIG_CENTER — native 96x96 sprite, centered in the 128 grid (round4.mjs)
const SPRITE_X = (128 - 96) / 2; // 16
const SPRITE_Y = (128 - 96) / 2; // 16

function prand(x, y, seed) {
  const v = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function nebulaClouds(grid, clusters) {
  for (const { cx, cy, r, color, seed, density } of clusters) {
    const [cr, cg, cb] = hex(color);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d > 1) continue;
        if (prand(x, y, seed) > density * (1 - d)) continue;
        const a = 35 + prand(x + 90, y + 90, seed + 3) * 90;
        blend(grid, x, y, [cr, cg, cb, Math.round(a)]);
      }
    }
  }
}

function starsField(grid, { count, seed, color }) {
  const [r, g, b] = hex(color);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(prand(i, 0, seed) * BASE4);
    const y = Math.floor(prand(0, i, seed) * BASE4);
    blend(grid, x, y, [r, g, b, 210]);
  }
}

/** Draws the 128-unit backdrop (full-bleed ground, nebula, stars, caret) —
 *  everything EXCEPT the real sprite, which ImageMagick composites in
 *  separately (see compositeSprite below). The ground fills the entire
 *  canvas edge-to-edge (no drawn corner rounding) — macOS applies its own
 *  squircle mask, so a self-drawn rounded tile would leave a transparent
 *  margin that gets composited onto the system's light icon backing plate. */
function drawBackdrop128() {
  const g = makeGrid(BASE4, BASE4);
  fillRect(g, 0, 0, BASE4, BASE4, GROUND);
  nebulaClouds(g, NEBULA_CLUSTERS);
  starsField(g, { count: STAR_COUNT, seed: STAR_SEED, color: P.gold });
  stampMask(g, CARET_XY4[0], CARET_XY4[1], CARET_MASK, P.gold, 255, CARET_SOLID);
  return g;
}

/** Backdrop, resampled to `size` actual pixels — nearestUpscale for size >=
 *  128 (clean integer multiples: 256, 512, 1024), boxDownscale for size <
 *  128 (64, 32, 16) so nebula dither box-averages into a soft flat tone
 *  instead of aliasing, while the solid-color caret/squircle edges stay
 *  crisp either way. */
function backdropAt(size) {
  const base = drawBackdrop128();
  if (size === BASE4) return base;
  return size > BASE4 ? nearestUpscale(base, size / BASE4) : boxDownscale(base, BASE4 / size);
}

/** Composites the real Garchomp sprite onto a backdrop PNG at `size` actual
 *  pixels. Resized straight from the 96x96 source at scale F = size/128 —
 *  point filter (crisp, nearest-neighbor) for F >= 1, box filter (averaged)
 *  for F < 1 — the same filter pairing round4.mjs used for the 512 render,
 *  applied here per-size instead of only once. */
function compositeSprite(backdropPath, size, outPath) {
  const f = size / BASE4;
  const spritePx = Math.max(1, Math.round(96 * f));
  const resized = join(TMP, `sprite-${size}.png`);
  if (f >= 1) {
    sh(`magick "${SPRITE}" -filter point -resize ${spritePx}x${spritePx} "${resized}"`);
  } else {
    sh(`magick "${SPRITE}" -filter box -resize ${spritePx}x${spritePx} "${resized}"`);
  }
  const ox = Math.round(SPRITE_X * f);
  const oy = Math.round(SPRITE_Y * f);
  sh(`magick "${backdropPath}" "${resized}" -geometry +${ox}+${oy} -composite "${outPath}"`);
}

/** Renders the full candidate-35 composition at `size` actual pixels. */
function renderIcon(size) {
  const backdropPath = join(TMP, `backdrop-${size}.png`);
  savePNG(backdropAt(size), backdropPath);
  const outPath = join(TMP, `icon-${size}.png`);
  compositeSprite(backdropPath, size, outPath);
  return outPath;
}

// ---------- iconset assembly ----------

// macOS .iconset naming convention (iconutil -c icns).
const ICONSET_FILES = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 }
];

function main() {
  if (!existsSync(SPRITE)) throw new Error(`missing sprite asset: ${SPRITE}`);
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });

  // Render each DISTINCT actual pixel size once (32 and 512 each feed two
  // filenames — no need to render them twice).
  const distinctSizes = [...new Set(ICONSET_FILES.map((f) => f.size))];
  const rendered = new Map();
  for (const size of distinctSizes) {
    rendered.set(size, renderIcon(size));
    console.log(`rendered ${size}x${size}`);
  }
  for (const { name, size } of ICONSET_FILES) {
    sh(`cp "${rendered.get(size)}" "${join(ICONSET, name)}"`);
  }

  const icnsOut = join(REPO_ROOT, 'build', 'icon.icns');
  if (process.platform === 'darwin') {
    sh(`iconutil -c icns "${ICONSET}" -o "${icnsOut}"`);
    console.log(`wrote ${icnsOut}`);
  } else {
    console.warn('iconutil is macOS-only — skipping .icns; re-run this script on a Mac to regenerate it.');
  }

  // Non-mac BrowserWindow icon (trivial extra output — see main/index.ts).
  const pngOut = join(HERE, 'icon.png');
  sh(`cp "${rendered.get(512)}" "${pngOut}"`);
  console.log(`wrote ${pngOut}`);

  // 1024px master, persisted (not just a _tmp render) as the single-layer
  // source image for the macOS 26 Tahoe Icon Composer asset — see
  // gen-tahoe-icon.mjs, which composites this into a .icon bundle.
  const png1024Out = join(HERE, 'icon-1024.png');
  sh(`cp "${rendered.get(1024)}" "${png1024Out}"`);
  console.log(`wrote ${png1024Out}`);

  rmSync(TMP, { recursive: true, force: true });
}

main();
