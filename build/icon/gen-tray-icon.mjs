// Pokéharness macOS menu-bar (Tray) icon generator — issue #17.
//
// A monochrome TEMPLATE image (macOS handles dark/light menu-bar adaptation
// itself once `nativeImage.setTemplateImage(true)` is set in tray.ts — this
// script only needs to produce a black-on-transparent alpha shape, never a
// colored one). A pokéball silhouette: outer circle, a horizontal band
// splitting it into two lobes, and a center button with its own small hole
// — the standard reduced pokéball glyph, recognizable at ~18-22pt.
//
// Craft note (see the project's own "icon mockup craft" lesson from issue
// #18's six-round exploration): flat, bold, high-contrast shapes are the
// correct craft at small icon sizes — internal texture/dithering reads as
// mush once compressed into ~18-22px, well BELOW even Dock/Finder icon
// sizes where that lesson was learned. So this is deliberately a flat 1-bit
// silhouette with only edge anti-aliasing (via supersample + box-downscale,
// same primitive gen-icon.mjs already uses for the app icon), not textured
// shading.
//
// Same pure-JS PNG encoder (Float64Array pixel grid, hand-rolled zlib PNG
// chunks) as gen-icon.mjs — no image-processing dependency needed for a
// shape this simple, so it isn't pulled in just for this script.
//
// Run: node build/icon/gen-tray-icon.mjs
// Writes build/icon/tray/pokeballTemplate.png (22x22, @1x) and
// build/icon/tray/pokeballTemplate@2x.png (44x44, @2x) — shipped into the
// packaged app via package.json's `build.mac.extraResources` (`tray/`) and
// read directly from the repo in dev (see tray.ts's `trayIconDir`).

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'tray');

// ---------- pixel grid + drawing primitives (subset of gen-icon.mjs's toolkit) ----------

function makeGrid(w, h) {
  return { w, h, data: new Float64Array(w * h * 4) };
}

function setOpaque(grid, x, y, alpha) {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
  const i = (y * grid.w + x) * 4;
  // Template images are pure black-on-alpha — RGB is always black; only the
  // alpha channel carries the shape.
  grid.data[i] = 0;
  grid.data[i + 1] = 0;
  grid.data[i + 2] = 0;
  grid.data[i + 3] = alpha;
}

function fillCircle(grid, cx, cy, r, alpha) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setOpaque(grid, x, y, alpha);
    }
  }
}

function clearRect(grid, x0, y0, x1, y1) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) setOpaque(grid, x, y, 0);
  }
}

function boxDownscale(grid, factor) {
  const w = grid.w / factor, h = grid.h / factor;
  const out = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const si = ((y * factor + dy) * grid.w + (x * factor + dx)) * 4;
          a += grid.data[si + 3];
        }
      }
      const di = (y * w + x) * 4;
      // RGB stays black (0) everywhere — only alpha is meaningful for a
      // template image, so a straight average is fine even where it mixes
      // opaque and transparent source pixels.
      out.data[di + 3] = a / (factor * factor);
    }
  }
  return out;
}

// ---------- PNG encoding (pure zlib, no image deps) — identical to gen-icon.mjs ----------

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

// ---------- pokéball glyph, drawn on a 22-unit conceptual grid, at 8x supersample ----------

const UNIT = 22; // @1x target size in px
const SUPER = 8; // supersample factor — master grid is UNIT*SUPER, downscaled by 8 (->22, @1x) and by 4 (->44, @2x)
const MASTER = UNIT * SUPER;

function drawPokeball() {
  const g = makeGrid(MASTER, MASTER);
  const cx = MASTER / 2;
  const cy = MASTER / 2;
  const r = 9 * SUPER; // diameter 18/22 units — leaves a couple px of breathing room, per the 18-22pt spec
  fillCircle(g, cx, cy, r, 255);

  // Horizontal dividing band — 2 units tall, full width of the circle's
  // bounding box (clearRect is cheaply over-wide; fillCircle already
  // bounded the shape, so clearing outside it is a no-op).
  const bandHalf = SUPER; // 1 unit above/below center = 2-unit-tall band
  clearRect(g, cx - r - SUPER, cy - bandHalf, cx + r + SUPER, cy + bandHalf);

  // Center button sits ON the band (solid), with a small hole punched
  // through its middle — the standard pokéball reduction.
  fillCircle(g, cx, cy, 2.4 * SUPER, 255);
  fillCircle(g, cx, cy, 1 * SUPER, 0);

  return g;
}

function main() {
  if (existsSync(OUT_DIR)) {
    // Best-effort clean regenerate — nothing else lives in this directory.
  }
  const master = drawPokeball();
  savePNG(boxDownscale(master, SUPER), join(OUT_DIR, 'pokeballTemplate.png')); // 22x22 @1x
  savePNG(boxDownscale(master, SUPER / 2), join(OUT_DIR, 'pokeballTemplate@2x.png')); // 44x44 @2x
  console.log(`wrote ${OUT_DIR}/pokeballTemplate.png (22x22) and pokeballTemplate@2x.png (44x44)`);
}

main();
