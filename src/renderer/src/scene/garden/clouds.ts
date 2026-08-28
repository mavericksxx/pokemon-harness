/**
 * Procedural pixel-art cumulus cloud sprites (Phase 8.8 art pass —
 * style-matched to a user-supplied stock reference: clusters of large
 * rounded domes with a flatter, gently-lumpy underside, two tones, chunky
 * stair-stepped pixel edges — generated FROM SCRATCH here as overlapping
 * dome circles rasterized onto a low-res canvas, never copied, traced, or
 * embedded from that reference).
 *
 * Same technique as this directory's nebula.ts: a small canvas, generated
 * once per distinct sprite with a deterministic seeded PRNG (never
 * `Math.random()`, so the scene is identical every launch), scaled up via
 * CSS `image-rendering: pixelated` (index.css's `.puff-shape`) so every
 * source pixel becomes a chunky stair-stepped block instead of a smooth
 * curve. Two tones only — white cloud body, one pale violet-grey shade for
 * the underside band and the creases where domes overlap — no outline: the
 * data URL's untouched pixels are fully transparent, so the white
 * silhouette steps directly against whatever sky sits behind it.
 *
 * `cloudSprite` takes each puff's own (left, size) as its dedupe/variety
 * key rather than a hand-authored variant name — ArceusAscent.tsx's
 * CLOUD_PUFFS/COVER_PUFFS arrays don't need a new field for this: every
 * puff just gets its own deterministic dome cluster, sized so the source
 * canvas keeps roughly the SAME on-screen pixel-step chunkiness regardless
 * of how big the puff itself is (see PIXEL_SCALE) rather than one fixed
 * resolution that reads chunky at one size and smooth at another.
 */

const WHITE: [number, number, number] = [244, 242, 251];
/** The one shade tone (undersides + creases) — same value the previous
 *  box-shadow-based puff shape used for its own underside/crease tones. */
const SHADE: [number, number, number] = [214, 210, 234];

/** Small deterministic PRNG (mulberry32) — same one nebula.ts uses. */
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

/** Cheap deterministic hash of a puff's own (left, size) — the same
 *  sin-based spread nebula.ts's dithering uses — turning each array entry
 *  into its own PRNG seed and dome count without widening CLOUD_PUFFS/
 *  COVER_PUFFS with a new field. */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Target ratio of on-screen display width to the source canvas width —
 *  what makes `image-rendering: pixelated` read as "chunky 2-3px
 *  stair-stepped curves" (the app's actual render scale) rather than
 *  near-smooth (ratio too low) or coarse voxels (ratio too high). Held the
 *  same for hero clusters and satellite minis alike so a satellite sitting
 *  beside a hero reads as the same art style, just smaller — not a
 *  different pixel density. */
const PIXEL_SCALE = 2.6;

interface Dome {
  cx: number;
  cy: number;
  r: number;
}

/** Every dome's bottom sits on this shared baseline (fraction of h) — what
 *  makes them read as one cluster "sitting on" a common base, biggest ones
 *  rising highest above it, rather than floating at independent heights. */
const BASELINE_FRAC = 0.6;

/** Fraction of (r_i + r_{i+1}) between adjacent dome CENTERS — close to 1
 *  means neighboring domes just touch (a visible dip between every pair,
 *  so you can count them); much less than 1 buries the smaller dome inside
 *  the bigger one and the cluster reads as one smooth blob instead of
 *  "3-6 distinct domes of clearly different radii". */
const DOME_OVERLAP = 0.86;

/** Places `count` domes left-to-right, one of them (not the first/last —
 *  "biggest dome off-center", 3+ domes only) notably bigger than the rest,
 *  spaced by their OWN radii (`DOME_OVERLAP`) so each keeps a separately
 *  countable peak rather than melting into a single silhouette — 3-6 for a
 *  hero cluster, 1-2 for a small satellite puff. Radii are computed first,
 *  then uniformly scaled down (never up) if the raw layout would overflow
 *  the canvas width. */
function buildDomes(rng: () => number, w: number, h: number, count: number): Dome[] {
  const baseline = h * BASELINE_FRAC;
  const bigIndex = count >= 3 ? 1 + Math.floor(rng() * (count - 2)) : 0;
  const rawR: number[] = [];
  for (let i = 0; i < count; i++) {
    const isBig = i === bigIndex;
    rawR.push(h * (isBig ? 0.32 + rng() * 0.18 : 0.16 + rng() * 0.16));
  }
  let rawSpan = rawR[0];
  for (let i = 1; i < count; i++) rawSpan += (rawR[i - 1] + rawR[i]) * DOME_OVERLAP;
  rawSpan += rawR[count - 1];
  const usableW = w * 0.86;
  const scale = rawSpan > usableW ? usableW / rawSpan : 1;

  const domes: Dome[] = [];
  let cx = w * 0.07 + rawR[0] * scale;
  for (let i = 0; i < count; i++) {
    const r = rawR[i] * scale;
    if (i > 0) cx += (rawR[i - 1] + rawR[i]) * DOME_OVERLAP * scale;
    domes.push({ cx: cx + (rng() - 0.5) * r * 0.12, r, cy: baseline - r + (rng() - 0.5) * h * 0.03 });
  }
  return domes;
}

function rasterizeCloud(seed: number, w: number, h: number, domeCount: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const rng = makeRng(seed);
  const domes = buildDomes(rng, w, h, domeCount);
  const baseline = h * BASELINE_FRAC;

  // The flatter, gently-lumpy underside band beneath the dome cluster —
  // spans the domes' own horizontal extent, a wavy bottom edge built from a
  // few random lumps (never a hard rectangle).
  const domeMinX = Math.min(...domes.map((d) => d.cx - d.r));
  const domeMaxX = Math.max(...domes.map((d) => d.cx + d.r));
  const bandBottomBase = h * 0.87;
  const lumps = Array.from({ length: 3 + Math.floor(rng() * 2) }, () => ({
    cx: domeMinX + rng() * (domeMaxX - domeMinX),
    amp: h * (0.03 + rng() * 0.05),
    freq: 0.18 + rng() * 0.18
  }));
  function bandBottomAt(x: number): number {
    let y = bandBottomBase;
    for (const l of lumps) y += l.amp * Math.exp(-(((x - l.cx) * l.freq) ** 2));
    return y;
  }
  /** The topmost dome boundary covering column `x` (its OWN circle arc, not
   *  a union outline) — `Infinity` where no dome reaches, which is exactly
   *  the gap/valley BETWEEN two domes (falls back to the flat `baseline`
   *  below, in the per-column loop). */
  function domeTopAt(x: number): number {
    let top = Infinity;
    for (const d of domes) {
      if (Math.abs(x - d.cx) <= d.r) {
        const t = d.cy - Math.sqrt(Math.max(0, d.r * d.r - (x - d.cx) * (x - d.cx)));
        if (t < top) top = t;
      }
    }
    return top;
  }

  // The shade tone occupies the bottom SHADE_FRAC of each COLUMN's own
  // local cloud height (top..bottom at that x) rather than a fixed
  // canvas-absolute y. That single rule does two things at once: under a
  // dome, the boundary traces that dome's own curved underside (never a
  // straight cut); in a valley between two domes — a short column, since no
  // dome reaches up there, just the flat baseline down to the band — the
  // same bottom-fraction covers most of it, reading as a shaded crease
  // exactly where the domes meet, with no separate "near an edge" case
  // needed.
  const SHADE_FRAC = 0.42;

  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const px = x + 0.5;
    if (px < domeMinX - 0.5 || px > domeMaxX + 0.5) continue; // transparent — sky shows through
    const top = Math.min(domeTopAt(px), baseline);
    const bottom = bandBottomAt(px);
    if (bottom <= top) continue;
    const localH = bottom - top;
    const shadeThreshold = bottom - SHADE_FRAC * localH;
    for (let y = 0; y < h; y++) {
      const py = y + 0.5;
      if (py < top || py > bottom) continue;
      const shaded = py >= shadeThreshold;
      const [r, g, b] = shaded ? SHADE : WHITE;
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Wider/flatter as more domes join the cluster (matches the reference: a
 *  single-dome puff is fairly round, a 6-dome row is a long flat band) —
 *  clamped so neither a 1-dome satellite nor a 6-dome hero goes to an
 *  extreme. */
function aspectForDomeCount(domeCount: number): number {
  return Math.max(0.34, Math.min(0.72, 0.78 - domeCount * 0.07));
}

const cache = new Map<string, { url: string; aspect: number }>();

/**
 * A cloud sprite for one puff. `key` is any stable per-puff number (callers
 * use `left * 1000 + size`, already unique across a fixed array) —
 * deterministically turned into both this sprite's dome-placement seed and
 * its dome count (1-2 if `satellite`, 3-6 otherwise), so the SAME puff
 * always gets the SAME cluster shape without a hand-authored seed table.
 * `displaySize` is the CSS width the caller intends to render this at
 * (drives the source canvas resolution — see PIXEL_SCALE); the returned
 * `aspect` (height/width) is what the caller must size its box with so the
 * sprite isn't stretched.
 */
export function cloudSprite(key: number, displaySize: number, satellite: boolean): { url: string; aspect: number } {
  const cacheKey = `${key}:${Math.round(displaySize)}:${satellite}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const h1 = hash01(key);
  const h2 = hash01(key + 1000.531);
  const domeCount = satellite ? 1 + Math.floor(h1 * 2) : 3 + Math.floor(h1 * 4);
  const seed = (Math.floor(h2 * 0xffffffff) ^ Math.floor(key * 977)) >>> 0;

  const aspect = aspectForDomeCount(domeCount);
  const w = Math.max(10, Math.round(displaySize / PIXEL_SCALE));
  const h = Math.max(7, Math.round(w * aspect));
  const url = rasterizeCloud(seed, w, h, domeCount);
  const result = { url, aspect: h / w };
  cache.set(cacheKey, result);
  return result;
}
