import { Container, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Point } from './TiledMapRenderer';

// Day/night cycle overlay (Backlog: "day/night animation pass"). Recipe
// finalized in a canvas2D mock (garden-daynight.html, 4 design iterations)
// before this port — every color/alpha/radius value below is lifted
// straight from that mock, not re-derived. One deliberate deviation from
// the mock: the moon pool anchors on this map's actual 'pond' zone
// (GardenScene.tsx reads it and passes the pixel center in) rather than the
// mock's fixed fraction of its own smaller test crop — anchoring moonlight
// to real water is strictly better than a landmark-blind fraction. The 3
// warm lamps do NOT get the same treatment: they stay at the mock's exact
// fractions (including the "gate arch" one) because this map's real 'gate'
// zone sits bottom-center, and snapping to it would cluster all 3 lamps
// into the bottom band — breaking the exact upper-middle-plus-two-corners
// composition the user iterated on 4 times. Composition fidelity wins over
// landmark-snapping for the lamps; it doesn't for the pool, which landed
// close to the mock's own position anyway.
//
// v1.6.0 shipped a 4-phase night/sunset/day/dawn design (sunset and dawn
// sharing one "low warm sun" recipe). Live user feedback: the sunset/dawn
// wash made the map look muted, so that whole visual layer — gradient wash,
// contact shadow, sun beam wedge, glint, sunset vignette — is removed here.
// Do not re-add it: this is now a plain day<->night crossfade, driven by a
// single `nightWeight` (see `nightWeightAt` below) instead of three summed
// phase weights.
//
// Architecture: one Container (`overlay.container`), built once per map
// mount, sitting above EVERYTHING else in `world` (border, tiles, walkers)
// — ambient lighting that should tint the whole scene, not just the tile
// floor. Every gradient is a canvas2D-baked Texture generated once at
// mount; the only per-frame cost (and only when motion is allowed) is
// nudging the 3 lamp sprites' alpha/scale/position. `nightWeight` (0 = day,
// 1 = night) is recomputed from local time on a 60s interval, not every
// frame.
//
// Two-tier night wash (user complaint: "the pokemon look so washed out and
// just - dull" at night — the single full-scene multiply wash above crushed
// each sprite's own hue, e.g. Pikachu yellow -> olive-brown, because it
// multiplied R/G far harder than B). Split into: Tier 1, `ambientWash`
// (still here in `nightLayer`, still above literally everything in `world`
// including characters) — weakened/desaturated so it darkens without
// crushing hue; Tier 2, `envWash`/`borderTierWash` — the ORIGINAL wash's
// stronger, more saturated color (see `ENV_WASH_STOPS` below), confined to
// the environment. Tier 2 reaches the environment two ways: as the wash
// sprite itself, below `liveLayer` inside `staticTiles`/`parent`, for
// anything that can sit there (floor/walls/trunks/border ring); and, for
// tree canopy + structure roofs — which TiledMapRenderer parents into or
// above `characterContainer` (=`liveLayer`) for Y-sort occlusion against
// walkers, so they can never receive the wash sprite — as an equivalent
// per-sprite `.tint`, the same multiply-blend math evaluated at that
// sprite's own Y instead of baked into a texture (`recompute()`'s
// `tintForY` closure, handed to `opts.applyCanopyNightTint` — see
// TiledMapRenderer's `setNightTint()`). Net effect: canopy, trunk and roof
// all land at the same effective Tier 1 x Tier 2 darkening; only characters
// (and anything else parented at/above `liveLayer`) get Tier 1 alone. Do
// not re-merge these back into one wash without re-solving this same
// hue-crush problem.

/** Morning window: night fades out to pure day over this leg (old dawn
 *  window's start through the old day-start keyframe). */
const MORNING_START = 5.3;
const MORNING_END = 8.5;

/** Evening window: day fades into night. Starts later than the old
 *  sunset-start keyframe (17.5) — 18.5 is closer to when dusk actually
 *  reads as dusk, so mid-evening isn't prematurely dark — and ends at the
 *  old night-start keyframe (20.8), unchanged. */
const EVENING_START = 18.5;
const EVENING_END = 20.8;

function ease(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
}

/** 0 = day, 1 = night, eased across the morning/evening windows above. */
function nightWeightAt(hour: number): number {
  if (hour <= MORNING_START || hour >= EVENING_END) return 1;
  if (hour >= MORNING_END && hour <= EVENING_START) return 0;
  if (hour < MORNING_END) return 1 - ease((hour - MORNING_START) / (MORNING_END - MORNING_START));
  return ease((hour - EVENING_START) / (EVENING_END - EVENING_START));
}

/** QA escape hatch (task ask: "a way to force a phase for QA without waiting
 *  for real time"). Reuses store.ts's own localStorage pattern exactly
 *  (`poke:` key prefix, best-effort try/catch, silently falls back on any
 *  failure) rather than adding a settings-store field — this is a one-off
 *  dev knob, not a user-facing setting, so the least invasive existing
 *  pattern wins. Set e.g. `localStorage.setItem('poke:daynightHourOverride',
 *  '22')` in devtools to preview night immediately, or '19.5' for evening
 *  dusk mid-transition. */
const HOUR_OVERRIDE_KEY = 'poke:daynightHourOverride';

function readHourOverride(): number | null {
  try {
    const v = window.localStorage.getItem(HOUR_OVERRIDE_KEY);
    if (v == null) return null;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n < 24) return n;
  } catch {
    /* ignore — same best-effort localStorage contract as store.ts */
  }
  return null;
}

function localHourNow(): number {
  const override = readHourOverride();
  if (override != null) return override;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

type GradientStop = [offset: number, color: string];

/** Tier 2's two gradient stops (top -> bottom), numeric so the same numbers
 *  drive both `envWash`/`borderTierWash`'s baked `verticalGradientTexture`
 *  and the per-sprite tint math in `recompute()` below (canopy/roof sprites
 *  can't sit below `liveLayer` for the wash sprite itself — see this file's
 *  header comment) — keeps the two from drifting apart if either recipe
 *  changes later. */
const ENV_WASH_STOPS: { offset: number; alpha: number; r: number; g: number; b: number }[] = [
  { offset: 0.0, alpha: 0.6, r: 80, g: 80, b: 245 },
  { offset: 1.0, alpha: 0.7, r: 79, g: 79, b: 229 }
];

/** `ENV_WASH_STOPS` as the rgba-string stops `verticalGradientTexture`
 *  expects — same numbers, just formatted; never diverges from the numeric
 *  source above. */
function envWashGradientStops(): GradientStop[] {
  return ENV_WASH_STOPS.map((s) => [s.offset, `rgba(${s.r},${s.g},${s.b},${s.alpha})`]);
}

/** The exact tint a `multiply`-blend sprite of alpha `a` and color (r,g,b)
 *  would produce on a backdrop: per channel, `result = base * (1 - a +
 *  a*c)`. Pixi's `.tint` is itself a per-channel multiply of the base
 *  texture's own color, so this packed value reproduces that blend on a
 *  sprite that never receives the actual wash sprite (see `setNightTint()`
 *  call in `recompute()`). */
function multiplyTint(a: number, r: number, g: number, b: number): number {
  const mix = (channel: number): number => {
    const v = 1 - a + a * (channel / 255);
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** A 1px-wide vertical gradient, stretched to full overlay width by the
 *  Sprite that uses it — the gradient never varies across x, so there's no
 *  reason to bake more than one column of pixels. */
function verticalGradientTexture(height: number, stops: GradientStop[]): Texture {
  const c = makeCanvas(1, height);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, height);
  return Texture.from(c, true);
}

/** A square radial gradient, centered, baked at its final on-screen diameter
 *  (`radius * 2`) — used for the moon pool and the lamp glow, both plain
 *  circular falloffs with no distortion. */
function radialGradientTexture(radius: number, stops: GradientStop[]): Texture {
  const size = Math.max(1, Math.round(radius * 2));
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, radius);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c, true);
}

/** The night vignette's geometry — baked at the overlay's full pixel bounds
 *  directly rather than as a reusable template, since the inner/outer radii
 *  deliberately use different bases (h for the inner radius, w for the
 *  outer one) and so aren't a plain uniform-scale circle a Sprite transform
 *  could reproduce. */
function vignetteTexture(width: number, height: number, stops: GradientStop[]): Texture {
  const c = makeCanvas(width, height);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.55, width * 0.5, height * 0.5, width * 0.575);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  return Texture.from(c, true);
}

/** One of the 3 warm practical lights (gate arch + 2 far corners). Baked at
 *  1.15x the static recipe's peak alpha so a per-frame alpha in
 *  [1/1.15, 1.0] reproduces the full ±15% flicker range without exceeding
 *  1.0 — see `update()`'s comment for why that also keeps the time-average
 *  brightness equal to the original static (non-flickering) look. */
interface Lamp {
  sprite: Sprite;
  baseX: number;
  baseY: number;
  period: number;
  phase: number;
}

const LAMP_PERIOD = [2.3, 3.1, 3.8];
const LAMP_PHASE = [0, 2.1, 4.4];

export interface DayNightOverlayOptions {
  /** Full overlay bounds, in `world`-space px — border-inclusive (see the
   *  border-coverage decision in GardenScene.tsx's mount comment: the wash/
   *  vignette/moon-pool paint over the border ring too, not just the map's
   *  own tile area, so the ring doesn't glow daylight at night). */
  widthPx: number;
  heightPx: number;
  /** Moon pool center, in that same world-space px — GardenScene.tsx reads
   *  garden.tmj's 'pond' zone and passes its pixel center in, rather than
   *  this overlay re-deriving a landmark position of its own. */
  poolCenter: Point;
  /** Gate-arch lamp position, same coordinate space — the approved mock's
   *  own fraction (0.4531w, 0.3611h), NOT garden.tmj's 'gate' zone: see this
   *  file's header comment for why the lamp composition wins over landmark
   *  snapping here. */
  gateLampCenter: Point;
  /** The map's own root container (TiledMapRenderer.getContainer()), used
   *  once to bake the silver-rim RenderTexture. NOTE: this container's own
   *  children include `characterContainer` (TiledMapRenderer parents it in
   *  for tile/character z-sorting) — walkers, battlers, and tool bubbles all
   *  live there once the scene populates. `liveLayer` below is exactly that
   *  container, passed separately so `mount()` can hide it for the single
   *  render call: a periodically-refreshed rim texture of a live scene would
   *  leave stale ghost highlights trailing anything that moves, and the
   *  recipe is explicit that must never happen — so this is enforced
   *  structurally (a renderable toggle at bake time), not left to depend on
   *  the caller happening to mount this overlay before any walker exists. */
  staticTiles: Container;
  /** TiledMapRenderer.getCharacterContainer() — see `staticTiles`' comment.
   *  Hidden for the one render call that bakes the rim snapshot, then
   *  restored; canopy tiles TiledMapRenderer itself parents into this same
   *  container (for z-sorting against walkers) are the one cosmetic cost —
   *  they won't pick up the rim highlight — traded deliberately for the
   *  guarantee that no live sprite ever can. */
  liveLayer: Container;
  /** `staticTiles`' own unshifted pixel size (map.width/height * tileSize).
   *  The rim RenderTexture is baked at exactly this size. */
  staticTilesWidthPx: number;
  staticTilesHeightPx: number;
  /** Where `staticTiles`' own (0,0) origin lands in THIS overlay's
   *  coordinate space — GardenScene's `borderPx`, since the map's content is
   *  inset by the border ring's thickness inside `world`. */
  staticTilesOffsetPx: Point;
  /** GardenScene.tsx's `content` container — the exact same instance added
   *  into `parent` (=`world`) there, sitting between `border` and the map's
   *  own tile/character art. Used only to locate the correct insertion
   *  index for `borderTierWash` (`parent.getChildIndex(this.opts.content)`)
   *  so that sprite lands directly in front of `border` without this class
   *  having to assume `world`'s exact child order. */
  content: Container;
  /** TiledMapRenderer.setNightTint() — called every `recompute()` with a
   *  closure that maps a sprite's own local Y (in `staticTiles`' frame) to
   *  the packed `.tint` reproducing Tier 2's multiply wash at that Y, so
   *  canopy/roof sprites (which live at/above `liveLayer` and so never
   *  receive the `envWash` sprite itself) land at the same effective
   *  darkening as everything below it. See this file's header comment. */
  applyCanopyNightTint?: (tintForY: (yPx: number) => number) => void;
}

/** Cheap Pixi-side day/night lighting pass — see this file's header comment
 *  for the overall recipe/architecture. Usage: construct, call `mount()`
 *  once the renderer exists and add nothing else (mount adds `container`
 *  itself into whatever parent you pass), call `update(dtSeconds)` from the
 *  scene's own ticker every frame, call `destroy()` from the same cleanup
 *  that tears down the rest of the scene (context-loss rebuild recreates a
 *  fresh Application and re-mounts everything, this overlay included). */
export class DayNightOverlay {
  readonly container = new Container();

  private readonly opts: DayNightOverlayOptions;
  private readonly nightLayer = new Container();
  private readonly lampLayer = new Container();
  private readonly lamps: Lamp[] = [];
  /** Tier 2 environment wash, live inside `staticTiles` (not a descendant of
   *  `this.container`) — see `mount()`. Null until `mount()` runs. */
  private envWash: Sprite | null = null;
  /** Tier 2b border-ring wash, live inside `parent` (not a descendant of
   *  `this.container`) — see `mount()`. Null until `mount()` runs. */
  private borderTierWash: Sprite | null = null;
  private readonly reducedMotion: boolean;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private clockSeconds = 0;

  constructor(opts: DayNightOverlayOptions) {
    this.opts = opts;
    this.reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.container.label = 'day-night-overlay';
    // Purely visual — sits above `world`'s whole hit area (GardenScene's
    // drag-to-pan/click-to-deselect gestures rely on Pixi's hit test falling
    // through to `world` itself for "empty ground"), so it must never be a
    // hit-test candidate of its own.
    this.container.eventMode = 'none';
    this.container.addChild(this.nightLayer, this.lampLayer);
  }

  /** Builds every gradient texture and sprite (including the one-time
   *  static-tile RenderTexture snapshot for the silver rim), adds
   *  `this.container` into `parent`, and computes the initial phase
   *  immediately — then starts the 60s recompute interval. */
  mount(renderer: Renderer, parent: Container): void {
    const {
      widthPx,
      heightPx,
      poolCenter,
      gateLampCenter,
      staticTiles,
      liveLayer,
      staticTilesWidthPx,
      staticTilesHeightPx,
      staticTilesOffsetPx,
      content
    } = this.opts;

    // ---- night ----

    // Tier 1 — weak "ambient" wash. Unchanged position in the stack (first
    // child of `nightLayer`, above EVERYTHING in `world` including
    // characters) but deliberately desaturated (R/G much closer to B than
    // the old single-wash recipe) so it darkens every sprite, characters
    // included, without crushing each one's own hue. See this file's header
    // comment for the two-tier rationale.
    const ambientWash = new Sprite(
      verticalGradientTexture(heightPx, [
        [0.0, 'rgba(110,110,205,0.50)'],
        [1.0, 'rgba(110,110,205,0.60)']
      ])
    );
    ambientWash.width = widthPx;
    ambientWash.blendMode = 'multiply';

    // Tier 2 — "environment" wash: the stronger, more saturated color the
    // old single wash used, but confined to the map's own tile art by
    // living INSIDE `staticTiles`, below `liveLayer` — so characters (and
    // anything else parented above `liveLayer`'s index) never receive it,
    // only Tier 1 above. Combines multiplicatively with Tier 1 on tile
    // pixels to land close to the original pre-split total darkening.
    // Positioned at local (0,0), NOT `staticTilesOffsetPx`: unlike
    // `silverRim` below (which lives in `nightLayer`, i.e. directly in this
    // overlay's own/world coordinate space, and so needs that offset to
    // line up with `staticTiles`' content), this sprite is a child of
    // `staticTiles` itself, so it's already in `staticTiles`' own
    // coordinate frame — applying the offset again here would double it and
    // misalign the wash from the tile art by one border-thickness.
    // NOT inserted into `staticTiles` yet — see the rim-bake block below for
    // why (this sprite starts at alpha 1, and the rim snapshot must not
    // bake in a full-strength night wash regardless of time of day).
    const envWash = new Sprite(verticalGradientTexture(staticTilesHeightPx, envWashGradientStops()));
    envWash.width = staticTilesWidthPx;
    envWash.blendMode = 'multiply';
    envWash.position.set(0, 0);
    this.envWash = envWash;

    // Tier 2b — same Tier 2 gradient, but sized/positioned to cover the
    // FULL border-inclusive bounds (like the old single wash did) and
    // inserted into `parent` directly in front of `content`. `content`'s
    // own opaque art, drawn afterward, occludes this sprite everywhere
    // `content` actually paints something, so in practice it's only ever
    // visible in the border margin outside `content` — restoring the
    // border ring's original (pre-split) darkening strength now that Tier 1
    // alone is too weak to do that on its own.
    const borderTierWash = new Sprite(verticalGradientTexture(heightPx, envWashGradientStops()));
    borderTierWash.width = widthPx;
    borderTierWash.blendMode = 'multiply';
    parent.addChildAt(borderTierWash, parent.getChildIndex(content));
    this.borderTierWash = borderTierWash;

    const moonPool = new Sprite(
      radialGradientTexture(widthPx * 0.32, [
        [0, 'rgba(235,240,255,0.65)'],
        [0.35, 'rgba(228,236,255,0.30)'],
        [0.6, 'rgba(220,230,255,0.05)'],
        [1.0, 'rgba(220,230,255,0)']
      ])
    );
    moonPool.anchor.set(0.5);
    moonPool.position.set(poolCenter.x, poolCenter.y);
    moonPool.blendMode = 'screen';

    // Silver-rim source: one RenderTexture snapshot of the static tile
    // layers, taken once, right now. Pixi's per-Sprite `tint` does the same
    // "multiply by a flat color" recolor the mock's `tintedCopy` does on
    // canvas.
    // `liveLayer` (walkers/battlers/bubbles, plus GardenCharm's props —
    // everything that isn't map art) is hidden for just this one render
    // call: `staticTiles` is TiledMapRenderer's root container, and
    // `liveLayer` is parented INSIDE it (for z-sorting), so capturing
    // `staticTiles` as-is would bake in whatever happens to be in
    // `liveLayer` at mount time. Nearest-neighbor scale mode matches the
    // tile atlases' own — a 1px rim offset should stay a crisp edge, not
    // soften into a linear-filtered haze. `envWash` (built above, not yet
    // parented into `staticTiles`) is added only AFTER this render call for
    // the same reason `liveLayer` is hidden for it: `envWash` starts at
    // alpha 1 (`recompute()` below hasn't run yet), so baking it in now
    // would freeze a full-strength night tint into the rim snapshot
    // regardless of actual time of day.
    const rimSource = RenderTexture.create({
      width: staticTilesWidthPx,
      height: staticTilesHeightPx,
      scaleMode: 'nearest'
    });
    const liveLayerWasRenderable = liveLayer.renderable;
    liveLayer.renderable = false;
    renderer.render({ container: staticTiles, target: rimSource });
    liveLayer.renderable = liveLayerWasRenderable;
    staticTiles.addChildAt(envWash, staticTiles.getChildIndex(liveLayer));

    const silverRim = new Sprite(rimSource);
    silverRim.tint = 0xd6e0ff;
    silverRim.blendMode = 'screen';
    silverRim.alpha = 0.1;
    silverRim.position.set(staticTilesOffsetPx.x, staticTilesOffsetPx.y - 1);

    const nightVignette = new Sprite(
      vignetteTexture(widthPx, heightPx, [
        [0, 'rgba(16,22,50,0)'],
        [1, 'rgba(16,22,50,0.32)']
      ])
    );
    nightVignette.blendMode = 'multiply';

    this.nightLayer.addChild(ambientWash, moonPool, silverRim, nightVignette);

    // ---- warm practical lights (fade in/out with `nightWeight`, same as
    // the rest of the night layer — lit only as night sets in, and fade
    // back out through morning) ----

    const lampTexture = radialGradientTexture(widthPx * 0.13, [
      [0, 'rgba(255,195,110,0.667)'],
      [0.4, 'rgba(255,190,120,0.322)'],
      [0.7, 'rgba(255,190,120,0.0575)'],
      [1, 'rgba(255,190,120,0)']
    ]);
    const lampBases: Point[] = [
      gateLampCenter,
      { x: widthPx * 0.1367, y: heightPx * 0.7986 },
      { x: widthPx * 0.8828, y: heightPx * 0.7639 }
    ];
    for (let i = 0; i < lampBases.length; i++) {
      const sprite = new Sprite(lampTexture);
      sprite.anchor.set(0.5);
      sprite.position.set(lampBases[i].x, lampBases[i].y);
      sprite.blendMode = 'screen';
      this.lampLayer.addChild(sprite);
      this.lamps.push({ sprite, baseX: lampBases[i].x, baseY: lampBases[i].y, period: LAMP_PERIOD[i], phase: LAMP_PHASE[i] });
    }
    this.applyLampRestState();

    parent.addChild(this.container);
    this.recompute();
    this.intervalId = setInterval(() => this.recompute(), 60_000);
  }

  /** `prefers-reduced-motion` still needs each lamp to sit at ITS static
   *  (non-flickering) look rather than at scale/position 0 — this is the
   *  "render the current phase as one static frame" the task calls for,
   *  applied to the one piece of the overlay that's otherwise animated. */
  private applyLampRestState(): void {
    for (const lamp of this.lamps) {
      lamp.sprite.position.set(lamp.baseX, lamp.baseY);
      lamp.sprite.scale.set(1);
      lamp.sprite.alpha = 1 / 1.15;
    }
  }

  /** Recomputes `nightWeight` from local time (or the QA override) — cheap
   *  (a few multiplies), called once at mount and every 60s after. Nothing
   *  here touches per-frame animation state. */
  private recompute(): void {
    const nightWeight = nightWeightAt(localHourNow());
    this.nightLayer.alpha = nightWeight;
    this.lampLayer.alpha = nightWeight;
    // `envWash`/`borderTierWash` aren't descendants of `nightLayer` (they
    // live inside `staticTiles`/`parent` respectively — see `mount()`), so
    // they need their own alpha set explicitly to fade with the same
    // `nightWeight`.
    if (this.envWash) this.envWash.alpha = nightWeight;
    if (this.borderTierWash) this.borderTierWash.alpha = nightWeight;

    // Canopy/roof sprites can't receive `envWash` itself (see header
    // comment) — hand the caller a closure reproducing the same multiply
    // blend as a `.tint`, sampling the same two stops at the sprite's own Y
    // instead of the baked gradient's per-pixel Y, and folding in
    // `nightWeight` the same way `envWash.alpha` above does.
    const staticTilesHeightPx = this.opts.staticTilesHeightPx;
    const [top, bottom] = ENV_WASH_STOPS;
    const tintForY = (yPx: number): number => {
      const yFrac = Math.max(0, Math.min(1, yPx / staticTilesHeightPx));
      const alpha = (top.alpha + (bottom.alpha - top.alpha) * yFrac) * nightWeight;
      const r = top.r + (bottom.r - top.r) * yFrac;
      const g = top.g + (bottom.g - top.g) * yFrac;
      const b = top.b + (bottom.b - top.b) * yFrac;
      return multiplyTint(alpha, r, g, b);
    };
    this.opts.applyCanopyNightTint?.(tintForY);
  }

  /** Current night<->day crossfade weight (0 = full day, 1 = full night) —
   *  a read-only mirror of `nightLayer.alpha`, which `recompute()` already
   *  sets to exactly this value. Exposed so battleFx.ts's advisor-companion
   *  aura (an effect that lives entirely outside this file, and outside
   *  this class's own render order) can dim its own additive brightness as
   *  night rises, since this overlay's screen-blend elements (`moonPool`,
   *  `silverRim` above) paint on TOP of the aura and stack with it —
   *  see battleFx.ts's `AURA_NIGHT_DIM` for the dimming math this feeds.
   *  Adds no new state of its own. */
  get nightWeight(): number {
    return this.nightLayer.alpha;
  }

  /** True while `update()` below is actually changing anything on screen —
   *  dirty-flag rendering (renderDirty.ts, GardenScene.tsx's ticker). Gated
   *  on `lampLayer.alpha` (set by `recompute()` to `nightWeight`, 0 during
   *  full daylight), not just `!reducedMotion`: the lamp sway/flicker math
   *  in `update()` still RUNS every frame regardless of daylight (cheap —
   *  see that method's own comment), but with the layer's alpha at exactly
   *  0 it paints no different pixels, and this is most of a typical
   *  workday's worth of hours (see MORNING_END/EVENING_START above) — the
   *  one subsystem here that would otherwise force this whole idle-render
   *  pass to keep the garden at 60fps all day for a change nobody can
   *  actually see. */
  get isAnimating(): boolean {
    return !this.reducedMotion && this.lampLayer.alpha > 0;
  }

  /** Per-frame lamp flicker/sway — the ONLY per-frame work this overlay
   *  does. No-op under `prefers-reduced-motion` (lamps stay at the static
   *  rest state `applyLampRestState` set once). */
  update(dtSeconds: number): void {
    if (this.reducedMotion) return;
    this.clockSeconds += dtSeconds;
    const t = this.clockSeconds;
    for (const lamp of this.lamps) {
      const f1 = (2 * Math.PI) / lamp.period;
      const f2 = f1 * 2.7;
      // Two-sine organic flicker (0.7/0.3 weights sum to 1, so this never
      // exceeds ±1 and still averages to 0 over a cycle) — a slow primary
      // wobble per lamp (different period each, so they never sync) plus a
      // faster, smaller secondary one for texture.
      const flicker = Math.sin(t * f1 + lamp.phase) * 0.7 + Math.sin(t * f2 + lamp.phase * 1.7) * 0.3;
      const swayX = Math.sin(t * 0.6 + lamp.phase) * 1.5;
      const swayY = Math.cos(t * 0.45 + lamp.phase * 1.3) * 1.2;
      lamp.sprite.position.set(lamp.baseX + swayX, lamp.baseY + swayY);
      lamp.sprite.scale.set(1 + flicker * 0.12);
      // (1 + flicker*0.15) is the recipe's alphaMul (±15% wobble around the
      // baked 1.15x peak); dividing by 1.15 here folds phaseFade (night's
      // own weight) OUT of this per-sprite alpha and into `lampLayer.alpha`
      // instead (set by `recompute()`), which is exactly equivalent to the
      // mock's `(alphaMul / 1.15) * phaseFade` since Pixi multiplies a
      // container's alpha into its children's own.
      lamp.sprite.alpha = (1 + flicker * 0.15) / 1.15;
    }
  }

  destroy(): void {
    if (this.intervalId != null) clearInterval(this.intervalId);
    this.intervalId = null;
    // Every texture here is privately baked for this one overlay instance
    // (never a shared bundled atlas the way Walker sprites are) — safe, and
    // worth doing, to also free the underlying GPU/canvas resources rather
    // than just the Pixi objects wrapping them.
    this.container.destroy({ children: true, texture: true, textureSource: true });
    // `envWash`/`borderTierWash` live outside `this.container` (inside
    // `staticTiles`/`parent` respectively — see `mount()`), so the destroy
    // above doesn't reach them; destroy each explicitly or they'd leak both
    // their Pixi objects and their baked GPU textures.
    this.envWash?.destroy({ texture: true, textureSource: true });
    this.envWash = null;
    this.borderTierWash?.destroy({ texture: true, textureSource: true });
    this.borderTierWash = null;
  }
}
