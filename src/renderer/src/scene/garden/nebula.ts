/**
 * The cosmos backdrop's nebula texture (Phase 8.8 §4, final revision) — a
 * horizontal lower-third galaxy band (warm orange/salmon core, near-black
 * dust-lane clumps, violet haze, deep-indigo corners) with heavy irregular
 * dithering and a scattered multicolor starfield. It is generated
 * PROCEDURALLY from scratch here (value noise + a stochastic/Bayer dither
 * blend + fixed-seed placements), never by copying, tracing, or embedding
 * any external image.
 *
 * Generated ONCE at module load as a small (low-res) canvas, exported as a
 * data URL; the CSS side (`index.css`'s `.garden-cosmos-nebula`) stretches
 * the complete source rectangle to the pane with `background-size: 100% 100%`
 * plus `image-rendering: pixelated`, so the band remains visible at every
 * pane aspect ratio and every source pixel still becomes a chunky block.
 * Deterministic (a small seeded PRNG, not `Math.random()`) so the backdrop is
 * the SAME every time this module loads, not reshuffled on every launch.
 *
 * The band's peak brightness is placed off-center (see `BAND_A`/`BAND_B`/
 * `PEAK_T`), deliberately away from (0.5, 0.5) where Arceus's sprite floats
 * (`.garden-cosmos` centers its figure) — the reference's hottest core
 * would otherwise sit directly behind him — and `CLEAR_RADIUS` backs that
 * up with an explicit calm blend right around center, regardless of where
 * the band math lands.
 */

/** A deliberately wide 16:9 source rectangle. CSS maps this whole rectangle
 * to the pane instead of cover-cropping it, keeping the lower band in frame
 * on both tall and wide layouts. `RES_SCALE` keeps the source pixels fine
 * enough for a starfield while the coarse dither blocks preserve the chunky
 * pixel-art read after scaling. */
const RES_SCALE = 4;
const WIDTH = Math.round(160 * RES_SCALE);
const HEIGHT = Math.round(90 * RES_SCALE);

/** Small deterministic PRNG (mulberry32) — same seed every load. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
].map((row) => row.map((v) => v / 16));

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// Palette ramp, cool -> warm: deep indigo corners -> violet haze -> warm
// core (orange/salmon). Dust-lane clumps punch near-black holes through
// the warm core, same as the reference's dark dust lanes.
const C_INDIGO: [number, number, number] = [10, 9, 28];
const C_VIOLET: [number, number, number] = [58, 34, 92];
const C_HAZE: [number, number, number] = [110, 70, 130];
const C_CORE: [number, number, number] = [214, 120, 90];
const C_CORE_BRIGHT: [number, number, number] = [244, 176, 128];
const C_DUST: [number, number, number] = [14, 9, 16];
/** A calm, neutral mid-tone — what the small clear zone directly behind
 *  Arceus blends toward, regardless of what the band math would otherwise
 *  put there (a belt-and-braces guarantee, on top of the band's own
 *  off-center placement — see CLEAR_RADIUS below). */
const C_CLEAR: [number, number, number] = [44, 32, 70];

/** Band centerline (fractions of W/H), run just beyond both horizontal edges
 *  so it reads as one continuous galaxy crossing the full view. The slight
 *  upward tilt keeps it organic without pulling it out of the lower third;
 *  the canvas CENTER (where Arceus floats) stays in calm dark space above
 *  the core and its violet fringe. Peak brightness sits toward the left,
 *  away from the sprite's center. */
const BAND_A = { x: -0.08, y: 0.85 };
const BAND_B = { x: 1.08, y: 0.78 };
const PEAK_T = 0.28;
/** Perpendicular falloff, fraction of the canvas diagonal — tight enough
 *  that the corners (and the area behind Arceus) actually read as dark,
 *  rather than the whole frame washing out toward the core. ~2/3 of the
 *  original 0.055 (backlog item: "backdrop looks zoomed in, not like the
 *  reference" — the band itself was reading as a wall filling the frame)
 *  so more deep-indigo sky/corners show and the band reads as one feature
 *  in a bigger frame rather than the whole frame. */
const BAND_WIDTH = 0.055 * (2 / 3);
/** Haze (violet, cooler than the core) extends further than the core
 *  itself before giving way to flat indigo — a wider multiple of
 *  BAND_WIDTH than the core's own falloff. */
const HAZE_WIDTH_MULT = 4.5;
/** Explicit clear zone around canvas CENTER (fraction of the diagonal) —
 *  guarantees calm space directly behind Arceus regardless of where the
 *  band math lands, rather than relying solely on the band's own
 *  off-center placement. */
const CLEAR_RADIUS = 0.11;

function generateNebulaDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = false;

  const rng = makeRng(0x41c3e5 ^ (ARCEUS_NEBULA_SEED_SALT * 2654435761));

  const diag = Math.hypot(WIDTH, HEIGHT);
  const ax = BAND_A.x * WIDTH;
  const ay = BAND_A.y * HEIGHT;
  const bx = BAND_B.x * WIDTH;
  const by = BAND_B.y * HEIGHT;
  const abx = bx - ax;
  const aby = by - ay;
  const abLen2 = abx * abx + aby * aby;

  // A handful of noise octaves (value noise via smoothed random lattice) for
  // dust-lane clump irregularity, cheap enough at this resolution to do
  // per-pixel with a small lattice + bilinear sample.
  const LATTICE = 16;
  const lattice: number[][] = Array.from({ length: LATTICE + 1 }, () =>
    Array.from({ length: LATTICE + 1 }, () => rng())
  );
  function noise(u: number, v: number): number {
    const gx = u * LATTICE;
    const gy = v * LATTICE;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const s00 = lattice[Math.min(LATTICE, y0)][Math.min(LATTICE, x0)];
    const s10 = lattice[Math.min(LATTICE, y0)][Math.min(LATTICE, x0 + 1)];
    const s01 = lattice[Math.min(LATTICE, y0 + 1)][Math.min(LATTICE, x0)];
    const s11 = lattice[Math.min(LATTICE, y0 + 1)][Math.min(LATTICE, x0 + 1)];
    return lerp(lerp(s00, s10, fx), lerp(s01, s11, fx), fy);
  }

  const img = ctx.createImageData(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // Perpendicular distance + position-along-band, both normalized.
      const apx = x - ax;
      const apy = y - ay;
      const t = abLen2 === 0 ? 0 : clamp01((apx * abx + apy * aby) / abLen2);
      const projX = ax + abx * t;
      const projY = ay + aby * t;
      const perp = Math.hypot(x - projX, y - projY) / diag;

      // Brightness: falls off perpendicular to the band (Gaussian-ish) and
      // tapers along it away from PEAK_T.
      const alongFalloff = 1 - Math.min(1, Math.abs(t - PEAK_T) * 1.15);
      const perpFalloff = Math.exp(-((perp / BAND_WIDTH) ** 2));
      let heat = clamp01(perpFalloff * lerp(0.35, 1, alongFalloff));

      // Dust-lane clumps: low-frequency noise carved OUT of the band's
      // heat wherever it crosses a threshold, concentrated near the band
      // itself (perp small) so dust reads as sitting IN the band, not
      // scattered across open sky.
      const dust = noise(x / WIDTH, y / HEIGHT);
      if (perp < BAND_WIDTH * 1.3 && dust > 0.56) {
        heat *= clamp01(1 - (dust - 0.56) * 2.6);
      }

      // Base ground color: indigo far out, violet haze nearer the band.
      const groundT = clamp01(1 - perp / (BAND_WIDTH * HAZE_WIDTH_MULT));
      let rgb = lerpRgb(C_INDIGO, C_VIOLET, groundT * 0.7);
      rgb = lerpRgb(rgb, C_HAZE, groundT * groundT * 0.6);

      // Warm core blends in on top as heat rises; a bright-white-ish
      // highlight only very near the peak.
      rgb = lerpRgb(rgb, C_CORE, heat);
      if (heat > 0.72) rgb = lerpRgb(rgb, C_CORE_BRIGHT, (heat - 0.72) / 0.28);

      // Dust lanes darken toward near-black, independent of the ground/core
      // blend above (dust sits ON TOP, occluding).
      if (perp < BAND_WIDTH * 1.3 && dust > 0.56) {
        const dustAmt = clamp01((dust - 0.56) * 2.6);
        rgb = lerpRgb(rgb, C_DUST, dustAmt * 0.85);
      }

      // Explicit clear zone directly behind Arceus (canvas center) — see
      // CLEAR_RADIUS's own comment.
      const distToCenter = Math.hypot(x - WIDTH / 2, y - HEIGHT / 2) / diag;
      if (distToCenter < CLEAR_RADIUS) {
        rgb = lerpRgb(rgb, C_CLEAR, (1 - distToCenter / CLEAR_RADIUS) * 0.65);
      }

      // Heavy dithering, deliberately IRREGULAR — a plain per-pixel Bayer4
      // threshold at this canvas' low resolution reads, once scaled up
      // blocky, as a perfectly uniform checkerboard (a transparency-grid
      // artifact, not grain). Two things break that up: a coarse 2x2-block
      // stochastic hash for cluster-scale variation, layered under a much
      // fainter Bayer4 component for fine texture — "blue-noise-ish" rather
      // than one repeating tile.
      // Block size scaled by RES_SCALE (was /2 at the original 128x80) so
      // the coarse stochastic cluster keeps its former ON-SCREEN size once
      // stretched to fill the pane — only the Bayer4 fine layer and the
      // underlying color field get genuinely finer at the new resolution.
      const blockX = Math.floor(x / (2 * RES_SCALE));
      const blockY = Math.floor(y / (2 * RES_SCALE));
      const blockHash = Math.sin(blockX * 12.9898 + blockY * 78.233 + 4.1) * 43758.5453;
      const blockRand = blockHash - Math.floor(blockHash);
      const bayer = BAYER4[y % 4][x % 4];
      const ditherAmt = (blockRand - 0.5) * 20 + (bayer - 0.5) * 8;
      rgb = [
        clamp01((rgb[0] + ditherAmt) / 255) * 255,
        clamp01((rgb[1] + ditherAmt) / 255) * 255,
        clamp01((rgb[2] + ditherAmt) / 255) * 255
      ];

      const i = (y * WIDTH + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  drawStars(ctx, rng);

  return canvas.toDataURL('image/png');
}

/** A dummy salt so re-seeding this file (if the look ever needs a refresh)
 *  is a one-constant change rather than hunting through the RNG call. */
const ARCEUS_NEBULA_SEED_SALT = 7;

const STAR_COLORS = ['#ffffff', '#bfe8ff', '#ffd9a8', '#ffb8f0'];

function drawStars(ctx: CanvasRenderingContext2D, rng: () => number): void {
  // Keep the same dense-but-calm starfield as the previous source while
  // accounting for the new 16:9 canvas area. Each star is still a fixed 1x1
  // source pixel, so its on-screen footprint remains intentionally tiny next
  // to the coarse dither blocks.
  const count = 1300;
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * WIDTH);
    const y = Math.floor(rng() * HEIGHT);
    const color = STAR_COLORS[Math.floor(rng() * STAR_COLORS.length)];
    ctx.globalAlpha = 0.45 + rng() * 0.5;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
    // Occasional 4-point cross twinkle on a plain 1px star.
    if (rng() < 0.12) {
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
    }
  }
  ctx.globalAlpha = 1;

  // A couple of "feature" stars with concentric pixel glow rings — kept
  // away from canvas center (Arceus's sprite sits there) and away from the
  // band's brightest core, same "stay a backdrop" reasoning as the heat
  // falloff above.
  const featureStars = [
    { x: 0.11 * WIDTH, y: 0.13 * HEIGHT, color: '#bfe8ff' },
    { x: 0.87 * WIDTH, y: 0.17 * HEIGHT, color: '#ffe3c2' }
  ];
  for (const s of featureStars) {
    for (let r = 3; r >= 0; r--) {
      ctx.globalAlpha = [0.12, 0.22, 0.4, 0.9][3 - r];
      ctx.fillStyle = s.color;
      ctx.beginPath();
      // Radius scaled by RES_SCALE too (like the star's own x/y above) so
      // its on-screen glow-ring size is preserved — composition, not grain.
      ctx.arc(s.x, s.y, r * RES_SCALE, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Computed once, lazily, the first time anything asks for it — module-level
 *  memoization so re-mounting the cosmos view (e.g. a renderer crash
 *  reload) doesn't regenerate it, but a plain script importing this module
 *  in a non-DOM context (there isn't one today) wouldn't crash on import
 *  either. */
let cached: string | null = null;
export function nebulaDataUrl(): string {
  if (cached === null) cached = generateNebulaDataUrl();
  return cached;
}
