/**
 * How big a Pokemon is drawn in the garden.
 *
 * Showdown's sheets are battle-scale: rendering them at native size puts a
 * Gengar across ten tiles and buries whole flower beds. But one flat multiplier
 * is wrong too — it would make Snorlax and Pikachu the same size, when the
 * native sheets already encode the size difference we want to keep.
 *
 * So the native frame height is normalised TOWARD a target range rather than
 * scaled by a constant: the smallest sheets land at SMALL_TILES tall, the
 * largest at LARGE_TILES, everything else in between. Snorlax still reads
 * bigger than Pikachu, and neither dwarfs the garden.
 *
 * DATA, on purpose: Phase 3's evolution feature grows a Pokemon by moving it
 * along this same scale, and a species that lands wrong gets one line in
 * TILE_HEIGHT_OVERRIDES instead of a special case in the renderer.
 */

/** On-screen height, in map tiles, for the smallest and largest native sheets. */
const SMALL_TILES = 2;
const LARGE_TILES = 3.5;

/** Native sheet heights (px) those two targets correspond to — the range the
 *  delivered Gen-5 sheets actually span (Pichu 37px … Charizard 91px). */
const SMALL_NATIVE = 37;
const LARGE_NATIVE = 91;

/**
 * Per-species height in tiles, when the curve gets one wrong. Keyed by Showdown
 * id (lowercase alphanumeric). Empty is the healthy state.
 */
export const TILE_HEIGHT_OVERRIDES: Record<string, number> = {};

/** Scale is snapped to eighths. Nearest-neighbour sampling at an arbitrary
 *  ratio drops pixel rows unevenly; a coarse grid keeps the shimmer down
 *  without pinning us to the integer divisors the varied native sizes cannot
 *  hit. */
const SCALE_STEP = 1 / 8;

/** Target drawn height in tiles for one species. */
export function targetTileHeight(name: string, nativeHeight: number): number {
  const override = TILE_HEIGHT_OVERRIDES[name];
  if (override !== undefined) return override;
  const t = (nativeHeight - SMALL_NATIVE) / (LARGE_NATIVE - SMALL_NATIVE);
  const clamped = Math.min(1, Math.max(0, t));
  return SMALL_TILES + clamped * (LARGE_TILES - SMALL_TILES);
}

/** The scale factor to draw one species' sheet at, on a `tileSize` grid. */
export function spriteScale(name: string, nativeHeight: number, tileSize: number): number {
  if (nativeHeight <= 0) return 1;
  const wanted = (targetTileHeight(name, nativeHeight) * tileSize) / nativeHeight;
  return Math.max(SCALE_STEP, Math.round(wanted / SCALE_STEP) * SCALE_STEP);
}
