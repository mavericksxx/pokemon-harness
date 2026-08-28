/**
 * The Arceus warp's visuals — replaces the old vertical ascent's cumulus
 * clouds (clouds.ts, deleted) and, as of this pass, the first version of
 * this file's own smoothly-scaled single-texture burst (which read as a
 * CSS effect, not pixel art — user feedback: "needs to be more in line with
 * our pixel art design"). Two small, hard-edged, flat-palette sprite sheets,
 * generated once per direction with a deterministic seeded PRNG (never
 * `Math.random()`):
 *
 * - `warpStreakFrameUrls(direction)` — a short sequence of RADIAL BURST
 *   frames (see `STREAK_FRAMES`), each its own crisp `GRID`x`GRID` raster.
 *   ArceusWarp.tsx swaps `background-image` between them (frame-flipping,
 *   NOT `transform: scale`) as progress moves toward/away from the
 *   midpoint — every frame maps to the pane the same fixed way
 *   (`background-size: cover`), so there's no fractional CSS scale factor
 *   to produce uneven block sizes the way scaling ONE texture did.
 * - `coverFrameUrls(direction)` — a Bayer-ordered dissolve (see
 *   `COVER_LEVELS`): flat-color cells fill in fixed order as the midpoint
 *   approaches, so the "hide the scene swap" moment reads as a blocky
 *   checkerboard wipe (classic battle-transition vocabulary) instead of a
 *   plain white opacity fade.
 *
 * Both are `image-rendering: pixelated` in CSS (`.garden-warp-streaks` /
 * `.garden-warp-flash`) so every source pixel stays a hard block. No
 * per-pixel color blending/lerping and no partial alpha anywhere in either
 * rasterizer — every filled cell is one of a small fixed set of flat
 * `PALETTES` colors at full opacity, per the "palette discipline, not alpha
 * gradients" direction.
 */

/** Logical grid size for the streak burst — deliberately small and chunky
 *  (a designed sprite, not a downsampled-for-cost raster): at a ~700px pane
 *  width that's ~22px per source pixel once `image-rendering: pixelated`
 *  blows it up, unmistakably blocky. */
const GRID = 32;
const CENTER = GRID / 2;

/** Small deterministic PRNG (mulberry32) — same one nebula.ts keeps its own
 *  copy of; matching that existing convention rather than extracting a
 *  shared helper for a single-line function. */
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

export type WarpDirection = 'up' | 'down';

/** `up` (garden -> cosmos): nebula-matched violets, so the burst hands off
 *  into the destination's own palette with no visible seam. `down` (cosmos
 *  -> garden): garden greens/golds (the app's brand gold, `design/tokens.ts`
 *  `gold` = #E8B740) — the one cheap direction cue the design brief asks
 *  for. Three flat tones per direction, used as-is (no blending) — this IS
 *  the "small fixed set of colors" the rework asks for. */
const PALETTES: Record<
  WarpDirection,
  { core: [number, number, number]; mid: [number, number, number]; dark: [number, number, number]; seed: number }
> = {
  up: { core: [232, 214, 255], mid: [120, 74, 168], dark: [14, 10, 34], seed: 0xa5ce11 },
  down: { core: [255, 240, 200], mid: [232, 183, 64], dark: [30, 46, 26], seed: 0x0d15ee }
};

function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ─── Radial burst frames ────────────────────────────────────────────────

/** Frame count for the burst sequence — index 0 is fully converged (rays
 *  retracted near the core, played right around the midpoint), the last
 *  index is fully spread (rays reaching toward the grid edge, played at the
 *  very start/end of the whole transition). ArceusWarp.tsx picks an index
 *  by distance from the midpoint; deliberately few frames (a low effective
 *  framerate reads as a game transition, not a tween). */
const STREAK_FRAMES = 6;

/** Fixed 16-point starburst, evenly spaced (no per-ray angle jitter — a
 *  deliberately regular, designed sprite rather than a noisy one) with
 *  alternating long/short rays for a classic speed-line rhythm. Built ONCE
 *  per direction from the seeded PRNG (picking width + color band per ray,
 *  the only randomized bits) and reused across all `STREAK_FRAMES` — the
 *  frames must draw the SAME rays at different reach, not re-roll a new
 *  layout each frame. */
interface RayDef {
  angle: number;
  /** Fraction of `CENTER` this ray reaches at full spread (frame index
   *  STREAK_FRAMES - 1). */
  lengthFrac: number;
  /** 1 or 2 grid cells wide. */
  width: 1 | 2;
  color: [number, number, number];
}

const RAY_COUNT = 16;

function buildRays(seed: number, mid: [number, number, number], dark: [number, number, number]): RayDef[] {
  const rng = makeRng(seed);
  return Array.from({ length: RAY_COUNT }, (_, i) => {
    const angle = (i / RAY_COUNT) * Math.PI * 2;
    const long = i % 2 === 0;
    return {
      angle,
      lengthFrac: long ? 0.92 : 0.6,
      width: rng() < 0.3 ? 2 : 1,
      color: rng() < 0.5 ? mid : dark
    };
  });
}

const RAY_LAYOUTS: Record<WarpDirection, RayDef[]> = {
  up: buildRays(PALETTES.up.seed, PALETTES.up.mid, PALETTES.up.dark),
  down: buildRays(PALETTES.down.seed, PALETTES.down.mid, PALETTES.down.dark)
};

/** Innermost radius every ray starts from — keeps a small gap around the
 *  core dot rather than every ray overlapping it. */
const RAY_INNER_R = 2;

function rasterizeStreakFrame(direction: WarpDirection, frameIndex: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = GRID;
  canvas.height = GRID;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = false;

  const reachT = frameIndex / (STREAK_FRAMES - 1); // 0 = converged, 1 = fully spread
  for (const ray of RAY_LAYOUTS[direction]) {
    const outerR = RAY_INNER_R + reachT * (ray.lengthFrac * CENTER - RAY_INNER_R);
    // Sample at least every half-cell along the ray so adjacent plotted
    // points never leave a gap once rounded to the integer grid — no
    // sub-pixel positions, every plotted cell is a whole grid cell.
    const steps = Math.max(1, Math.ceil((outerR - RAY_INNER_R) * 2));
    const dx = Math.cos(ray.angle);
    const dy = Math.sin(ray.angle);
    ctx.fillStyle = rgb(ray.color);
    for (let s = 0; s <= steps; s++) {
      const r = RAY_INNER_R + (outerR - RAY_INNER_R) * (s / steps);
      const gx = Math.round(CENTER + dx * r);
      const gy = Math.round(CENTER + dy * r);
      ctx.fillRect(gx, gy, 1, 1);
      if (ray.width === 2) {
        // Thicken by one cell along the perpendicular — still a hard-edged
        // block, not a soft stroke.
        ctx.fillRect(Math.round(gx - dy), Math.round(gy + dx), 1, 1);
      }
    }
  }

  // Small fixed core anchor, always present — a plus shape only in the
  // frames nearest convergence (two discrete states, not a size gradient).
  const { core } = PALETTES[direction];
  ctx.fillStyle = rgb(core);
  ctx.fillRect(CENTER - 1, CENTER - 1, 2, 2);
  if (reachT < 0.4) {
    ctx.fillRect(CENTER - 2, CENTER, 4, 1);
    ctx.fillRect(CENTER, CENTER - 2, 1, 4);
  }

  return canvas.toDataURL('image/png');
}

const streakCache = new Map<WarpDirection, string[]>();

/** Lazily generated + memoized per direction, `STREAK_FRAMES`-long. */
export function warpStreakFrameUrls(direction: WarpDirection): string[] {
  const cached = streakCache.get(direction);
  if (cached) return cached;
  const frames = Array.from({ length: STREAK_FRAMES }, (_, i) => rasterizeStreakFrame(direction, i));
  streakCache.set(direction, frames);
  return frames;
}

// ─── Midpoint cover dissolve ────────────────────────────────────────────

/** Same 4x4 ordered-dither matrix nebula.ts uses (there as fractions for a
 *  blend; here as raw 0..15 FILL ORDER — cell (x,y) turns on at cover level
 *  `BAYER4_ORDER[y%4][x%4] + 1`, never partially, so tiling it across the
 *  cover grid gives a classic blocky Bayer dissolve instead of a smooth
 *  radial wipe. */
const BAYER4_ORDER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

/** Cover grid is coarser than the streak grid on purpose — bigger flat
 *  cells read as a deliberate checkerboard, not a texture. */
const COVER_COLS = 10;
const COVER_ROWS = 6;

/** 0 (nothing filled) .. `BAYER4_ORDER`'s max order (15) + 1 = fully
 *  covered — the level ArceusWarp.tsx holds through the flash plateau,
 *  which is what actually hides the `.garden`/`.garden-cosmos` swap. */
const COVER_LEVELS = 17;

/** Flat cover color per direction — reuses each palette's own `mid` tone
 *  (the same violet the streaks use going up; the app's own brand gold
 *  going down), not a new hand-picked color, so the cover reads as part of
 *  the same direction cue rather than a separate effect. */
const COVER_COLOR: Record<WarpDirection, string> = {
  up: rgb(PALETTES.up.mid),
  down: rgb(PALETTES.down.mid)
};

function rasterizeCoverFrame(direction: WarpDirection, level: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = COVER_COLS;
  canvas.height = COVER_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = COVER_COLOR[direction];
  for (let y = 0; y < COVER_ROWS; y++) {
    for (let x = 0; x < COVER_COLS; x++) {
      if (BAYER4_ORDER[y % 4][x % 4] < level) ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL('image/png');
}

const coverCache = new Map<WarpDirection, string[]>();

/** Lazily generated + memoized per direction, `COVER_LEVELS`-long (index 0
 *  is fully transparent — nothing filled). */
export function coverFrameUrls(direction: WarpDirection): string[] {
  const cached = coverCache.get(direction);
  if (cached) return cached;
  const frames = Array.from({ length: COVER_LEVELS }, (_, level) => rasterizeCoverFrame(direction, level));
  coverCache.set(direction, frames);
  return frames;
}
