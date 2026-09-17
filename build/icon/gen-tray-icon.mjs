// Pokéharness macOS menu-bar (Tray) icon generator — issue #17.
//
// A monochrome TEMPLATE image (macOS handles dark/light menu-bar adaptation
// itself once `nativeImage.setTemplateImage(true)` is set in tray.ts — this
// script only needs to produce a black-on-transparent alpha shape, never a
// colored one). A HALF-FILLED pokéball glyph: the top half of the outer
// disc is filled solid, the bottom half is an outlined ring (stroke, not a
// filled disc), plus a horizontal band across the middle at the same
// stroke weight and a center button with its own small hole.
//
// History: commit 869679f deliberately changed this glyph FROM a solid
// disc TO a fully hollow outline, because a filled disc this size reads
// far denser than the hairline stroke-weight glyphs macOS puts beside it
// in the menu bar (Wi-Fi, battery, Control Center) — it read as a dark
// smudge, not a pokéball. This half-fill is a deliberate partial move back
// toward the solid look, at roughly half the density: the bottom half
// stays a hairline ring so the shape doesn't tip back into smudge
// territory, while the solid top half + band read as a clearly
// recognizable pokéball silhouette. The interior punch that hollows out
// the bottom half starts exactly at the band's bottom edge, so the solid
// fill stops cleanly at the band instead of bleeding into or thickening
// it, and the center button's hole is drawn last so it stays a legible
// knockout against the solid top rather than disappearing into it.
//
// Craft note (see the project's own "icon mockup craft" lesson from issue
// #18's six-round exploration): flat, bold, high-contrast shapes are the
// correct craft at small icon sizes — internal texture/dithering reads as
// mush once compressed into ~18-22px, well BELOW even Dock/Finder icon
// sizes where that lesson was learned. So this is deliberately a flat 1-bit
// shape with only edge anti-aliasing (via supersample + box-downscale, same
// primitive gen-icon.mjs already uses for the app icon), not textured
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

// yMin/yMax optionally clip the fill to a horizontal band (in pixel-center
// coordinates) — used to punch the inner circle hollow for only part of
// the disc (see the top-half-filled pokéball glyph below).
function fillCircle(grid, cx, cy, r, alpha, yMin = -Infinity, yMax = Infinity) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    if (y + 0.5 < yMin || y + 0.5 >= yMax) continue;
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setOpaque(grid, x, y, alpha);
    }
  }
}

function rect(grid, x0, y0, x1, y1, alpha) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) setOpaque(grid, x, y, alpha);
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

  const outerR = 9 * SUPER; // diameter 18/22 units — leaves a couple px of breathing room, per the 18-22pt spec
  const innerR = 7.1 * SUPER; // punch-out radius — leaves a ~1.9-unit ring stroke where hollow
  const bandHalf = 0.95 * SUPER; // 1.9-unit-tall band, matching the ring stroke

  // Outer disc — filled solid everywhere first (the top-half-filled move).
  fillCircle(g, cx, cy, outerR, 255);
  // Then punched hollow, but ONLY below the band, turning the bottom half
  // into a ~1.9-unit ring stroke while leaving the top half + band solid.
  // The punch starts exactly at the band's bottom edge so the solid fill
  // stops cleanly there instead of bleeding into or thickening the band.
  fillCircle(g, cx, cy, innerR, 0, cy + bandHalf, Infinity);

  // Horizontal dividing band — filled at the same ~1.9-unit stroke weight
  // as the ring, spanning the ring's full width so it reads as a bar
  // across it. Drawn explicitly (rather than relying on the top-half fill
  // already covering this row range) so its flat-edged rectangular shape
  // — not the circle's slightly narrower curve at this y — is preserved
  // exactly as before.
  rect(g, cx - outerR, cy - bandHalf, cx + outerR, cy + bandHalf, 255);

  // Center button sits on the band (solid), with a small hole punched
  // through its middle — the standard pokéball reduction. Drawn last so
  // its hole punches cleanly through the solid top-half fill instead of
  // disappearing into it.
  fillCircle(g, cx, cy, 2.7 * SUPER, 255);
  fillCircle(g, cx, cy, 1.15 * SUPER, 0);

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
