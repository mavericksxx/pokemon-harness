/**
 * Canvas-rasterized radial warp-streak burst (replaces the old vertical
 * ascent's cumulus clouds — clouds.ts, deleted). Same technique as this
 * directory's nebula.ts: a small canvas, generated once per direction with a
 * deterministic seeded PRNG (never `Math.random()`, so the burst is
 * identical every launch), scaled up via CSS `image-rendering: pixelated`
 * (index.css's `.garden-warp-streaks`) so the rays read as chunky pixel
 * streaks rather than a smooth CSS gradient.
 *
 * One sprite serves BOTH halves of the warp: ArceusWarp.tsx animates it with
 * a plain CSS `transform: scale(...)`, shrinking it toward a point for the
 * converge half and growing it back out for the diverge half — the SAME
 * texture run in reverse, which is what keeps the two directions visually
 * symmetric per the design brief.
 */

// 2.5x the original 128 — matches nebula.ts's own RES_SCALE bump (backlog
// item: cosmos "looks too zoomed in") so the warp's grain doesn't suddenly
// read chunkier than the cosmos backdrop it reveals; both canvases were 128
// before this pass, both are 320 now.
const RES_SCALE = 2.5;
const SIZE = 128 * RES_SCALE;
const CENTER = SIZE / 2;
/** Pixels from center to the nearest edge — rays are normalized against
 *  this so `radius` is a plain 0..1 (plus corner overshoot) fraction. */
const MAX_RADIUS = CENTER;

/** Small deterministic PRNG (mulberry32) — same one nebula.ts/clouds.ts each
 *  keep their own copy of; matching that existing convention rather than
 *  extracting a shared helper for a single-line function. */
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

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export type WarpDirection = 'up' | 'down';

/** `up` (garden -> cosmos): nebula-matched violets, so the burst hands off
 *  into the destination's own palette with no visible seam. `down` (cosmos
 *  -> garden): garden greens/golds (the app's brand gold, `design/tokens.ts`
 *  `gold` = #E8B740) — the one cheap direction cue the design brief asks
 *  for. */
const PALETTES: Record<
  WarpDirection,
  { core: [number, number, number]; mid: [number, number, number]; dark: [number, number, number]; seed: number }
> = {
  up: { core: [232, 214, 255], mid: [120, 74, 168], dark: [14, 10, 34], seed: 0xa5ce11 },
  down: { core: [255, 240, 200], mid: [232, 183, 64], dark: [30, 46, 26], seed: 0x0d15ee }
};

const RAY_COUNT = 56;

function rasterizeWarpStreaks(direction: WarpDirection): string {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const { core, mid, dark, seed } = PALETTES[direction];
  const rng = makeRng(seed);

  // Each ray: an evenly-spaced angular slot, lightly jittered so the burst
  // doesn't read as a perfect pinwheel, with its own length/width/intensity.
  const rays = Array.from({ length: RAY_COUNT }, (_, i) => {
    const slot = (i / RAY_COUNT) * Math.PI * 2;
    return {
      angle: slot + (rng() - 0.5) * ((Math.PI * 2) / RAY_COUNT) * 0.7,
      length: 0.55 + rng() * 0.55,
      halfWidth: 0.012 + rng() * 0.02,
      intensity: 0.4 + rng() * 0.6
    };
  });

  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - CENTER;
      const dy = y + 0.5 - CENTER;
      const radius = Math.hypot(dx, dy) / MAX_RADIUS;
      const angle = Math.atan2(dy, dx);

      let rayBrightness = 0;
      for (const ray of rays) {
        let d = Math.abs(angle - ray.angle);
        if (d > Math.PI) d = Math.PI * 2 - d;
        if (d > ray.halfWidth || radius > ray.length) continue;
        const angularFalloff = 1 - d / ray.halfWidth;
        const tailStart = ray.length * 0.7;
        const lengthFalloff = radius > tailStart ? 1 - (radius - tailStart) / (ray.length - tailStart) : 1;
        rayBrightness = Math.max(rayBrightness, ray.intensity * angularFalloff * clamp01(lengthFalloff));
      }

      // Bright core near center regardless of which rays land there.
      const coreGlow = clamp01(1 - radius / 0.16);
      const heat = clamp01(Math.max(rayBrightness, coreGlow));

      let rgb = lerpRgb(dark, mid, clamp01(heat * 1.4));
      if (heat > 0.6) rgb = lerpRgb(rgb, core, (heat - 0.6) / 0.4);

      // Coarse dither, same reasoning as nebula.ts — breaks up flat bands at
      // this low a resolution once scaled up pixelated. Block size scaled by
      // RES_SCALE (was /2 at the original SIZE 128) so the cluster keeps its
      // former on-screen size, same fix as nebula.ts's own blockX/blockY.
      const blockHash =
        Math.sin(Math.floor(x / (2 * RES_SCALE)) * 12.9898 + Math.floor(y / (2 * RES_SCALE)) * 78.233 + 4.1) *
        43758.5453;
      const ditherAmt = (blockHash - Math.floor(blockHash) - 0.5) * 18;
      rgb = [
        clamp01((rgb[0] + ditherAmt) / 255) * 255,
        clamp01((rgb[1] + ditherAmt) / 255) * 255,
        clamp01((rgb[2] + ditherAmt) / 255) * 255
      ];

      const i = (y * SIZE + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = Math.round(clamp01(heat * 1.1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

const cache = new Map<WarpDirection, string>();

/** Lazily generated + memoized per direction (module-level, like
 *  nebula.ts's own cache) — computed once, the first time either direction
 *  is actually needed. */
export function warpStreaksDataUrl(direction: WarpDirection): string {
  const cached = cache.get(direction);
  if (cached) return cached;
  const url = rasterizeWarpStreaks(direction);
  cache.set(direction, url);
  return url;
}
