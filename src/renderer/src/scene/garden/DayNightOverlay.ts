import { Container, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Point } from './TiledMapRenderer';

// Day/night cycle overlay (Backlog: "day/night animation pass"). Recipe
// finalized in a canvas2D mock (garden-daynight.html, 4 design iterations)
// before this port — every color/alpha/radius value below is lifted
// straight from that mock, not re-derived. Two deliberate deviations from
// the mock, both because the mock painted a small fixed test crop and this
// overlay paints the REAL garden.tmj map:
//  1) the moon pool and gate lamp anchor on this map's actual 'pond'/'gate'
//     zones (GardenScene.tsx reads those and passes pixel centers in) rather
//     than the mock's fixed fractions of its own crop.
//  2) the sunset wash is a HORIZONTAL gradient (matching the mock's actual
//     `gradeSunset` code, `createLinearGradient(0,0,w,0)`) even though the
//     brief accompanying that mock describes it as "vertical" — the mock's
//     own source is treated as the ground truth for "the exact final look".
//
// Architecture: one Container (`overlay.container`), built once per map
// mount, sitting above EVERYTHING else in `world` (border, tiles, walkers)
// — ambient lighting that should tint the whole scene, not just the tile
// floor. Every gradient is a canvas2D-baked Texture generated once at
// mount; the only per-frame cost (and only when motion is allowed) is
// nudging the 3 lamp sprites' alpha/scale/position. Phase (which of
// night/sunset/day is showing, and how strongly) is recomputed from local
// time on a 60s interval, not every frame.

/** Local-time keyframes for the day/night blend — `n`/`s`/`d` (night/sunset/
 *  day) weights, always summing to 1, eased between adjacent rows. Dawn has
 *  no keyframe of its own: it's the 5.3-6.7 night->sunset leg below, so the
 *  same warm-low-sun sunset recipe covers both dusk and dawn (the mock's own
 *  rationale: inventing a distinct 4th grade for dawn wasn't worth it when
 *  "low warm sun" already describes both). */
const KEYFRAMES: Array<[hour: number, weights: { n: number; s: number; d: number }]> = [
  [0.0, { n: 1, s: 0, d: 0 }],
  [5.3, { n: 1, s: 0, d: 0 }],
  [6.7, { n: 0, s: 1, d: 0 }],
  [8.5, { n: 0, s: 0, d: 1 }],
  [16.0, { n: 0, s: 0, d: 1 }],
  [17.5, { n: 0, s: 1, d: 0 }],
  [19.7, { n: 0, s: 1, d: 0 }],
  [20.8, { n: 1, s: 0, d: 0 }],
  [24.0, { n: 1, s: 0, d: 0 }]
];

function ease(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
}

function weightsAt(hour: number): { n: number; s: number; d: number } {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const [ha, wa] = KEYFRAMES[i];
    const [hb, wb] = KEYFRAMES[i + 1];
    if (hour >= ha && hour <= hb) {
      const t = hb === ha ? 0 : (hour - ha) / (hb - ha);
      const e = ease(t);
      return {
        n: wa.n + (wb.n - wa.n) * e,
        s: wa.s + (wb.s - wa.s) * e,
        d: wa.d + (wb.d - wa.d) * e
      };
    }
  }
  return { n: 1, s: 0, d: 0 };
}

/** QA escape hatch (task ask: "a way to force a phase for QA without waiting
 *  for real time"). Reuses store.ts's own localStorage pattern exactly
 *  (`poke:` key prefix, best-effort try/catch, silently falls back on any
 *  failure) rather than adding a settings-store field — this is a one-off
 *  dev knob, not a user-facing setting, so the least invasive existing
 *  pattern wins. Set e.g. `localStorage.setItem('poke:daynightHourOverride',
 *  '22')` in devtools to preview night immediately, or '18.5' for sunset. */
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

/** Same idea, 1px tall, for the sunset wash's horizontal gradient. */
function horizontalGradientTexture(width: number, stops: GradientStop[]): Texture {
  const c = makeCanvas(width, 1);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, width, 0);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, 1);
  return Texture.from(c, true);
}

/** A square radial gradient, centered, baked at its final on-screen diameter
 *  (`radius * 2`) — used for the moon pool, the lamp glow, and the glint,
 *  all plain circular falloffs with no distortion. */
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

/** The sunset's low-sun beam: a radial gradient stretched into a wedge via a
 *  non-uniform scale BEFORE drawing (mock's `ctx.scale(1.8, 0.55)`), so the
 *  ellipse is baked into the texture itself rather than needing a non-
 *  uniform Sprite scale (which the vignette below can't use either way,
 *  since its two radii come from different bases — see `vignetteTexture`). */
function sunBeamTexture(radius: number, stops: GradientStop[]): Texture {
  const scaleX = 1.8;
  const scaleY = 0.55;
  const w = Math.max(1, Math.round(radius * scaleX * 2));
  const h = Math.max(1, Math.round(radius * scaleY * 2));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  ctx.scale(scaleX, scaleY);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  // Covers the full radius in the (already scaled) local coordinate space;
  // the gradient itself clamps to transparent past offset 1.0 either way.
  ctx.fillRect(-radius * 1.1, -radius * 1.1, radius * 2.2, radius * 2.2);
  return Texture.from(c, true);
}

/** Night and sunset vignettes share this exact geometry (mock's own note:
 *  "same corrected geometry as the sunset vignette") — baked at the
 *  overlay's full pixel bounds directly rather than as a reusable template,
 *  since the inner/outer radii deliberately use different bases (h for the
 *  inner radius, w for the outer one) and so aren't a plain uniform-scale
 *  circle a Sprite transform could reproduce. */
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
  /** Gate-arch lamp position, same coordinate space — garden.tmj's 'gate'
   *  zone center. */
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
   *  they won't pick up the rim highlight / sunset contact-shadow — traded
   *  deliberately for the guarantee that no live sprite ever can. */
  liveLayer: Container;
  /** `staticTiles`' own unshifted pixel size (map.width/height * tileSize).
   *  The rim RenderTexture is baked at exactly this size. */
  staticTilesWidthPx: number;
  staticTilesHeightPx: number;
  /** Where `staticTiles`' own (0,0) origin lands in THIS overlay's
   *  coordinate space — GardenScene's `borderPx`, since the map's content is
   *  inset by the border ring's thickness inside `world`. */
  staticTilesOffsetPx: Point;
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
  private readonly sunsetLayer = new Container();
  private readonly lampLayer = new Container();
  private readonly lamps: Lamp[] = [];
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
    this.container.addChild(this.nightLayer, this.sunsetLayer, this.lampLayer);
  }

  /** Builds every gradient texture and sprite (including the one-time
   *  static-tile RenderTexture snapshot for the silver rim / sunset contact
   *  shadow), adds `this.container` into `parent`, and computes the initial
   *  phase immediately — then starts the 60s recompute interval. */
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
      staticTilesOffsetPx
    } = this.opts;

    // ---- night ----

    const nightWash = new Sprite(
      verticalGradientTexture(heightPx, [
        [0.0, 'rgba(50,50,213,0.72)'],
        [1.0, 'rgba(64,64,203,0.88)']
      ])
    );
    nightWash.width = widthPx;
    nightWash.blendMode = 'multiply';

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

    // Silver-rim / sunset-contact-shadow shared source: one RenderTexture
    // snapshot of the static tile layers, taken once, right now. Two Sprite
    // instances below reuse it with different tint/blend/offset/alpha —
    // Pixi's per-Sprite `tint` does the same "multiply by a flat color"
    // recolor the mock's `tintedCopy` does on canvas, so this is one GPU
    // texture serving both passes.
    // `liveLayer` (walkers/battlers/bubbles, plus GardenCharm's props —
    // everything that isn't map art) is hidden for just this one render
    // call: `staticTiles` is TiledMapRenderer's root container, and
    // `liveLayer` is parented INSIDE it (for z-sorting), so capturing
    // `staticTiles` as-is would bake in whatever happens to be in
    // `liveLayer` at mount time. Nearest-neighbor scale mode matches the
    // tile atlases' own — a 1px rim offset should stay a crisp edge, not
    // soften into a linear-filtered haze.
    const rimSource = RenderTexture.create({
      width: staticTilesWidthPx,
      height: staticTilesHeightPx,
      scaleMode: 'nearest'
    });
    const liveLayerWasRenderable = liveLayer.renderable;
    liveLayer.renderable = false;
    renderer.render({ container: staticTiles, target: rimSource });
    liveLayer.renderable = liveLayerWasRenderable;

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

    this.nightLayer.addChild(nightWash, moonPool, silverRim, nightVignette);

    // ---- sunset (also covers dawn — see KEYFRAMES' own comment) ----

    const sunsetWash = new Sprite(
      horizontalGradientTexture(widthPx, [
        [0.0, 'rgba(255,150,40,0.60)'],
        [0.45, 'rgba(220,80,60,0.50)'],
        [1.0, 'rgba(120,30,130,0.58)']
      ])
    );
    sunsetWash.height = heightPx;
    sunsetWash.blendMode = 'multiply';

    const contactShadow = new Sprite(rimSource);
    contactShadow.tint = 0x64233c;
    contactShadow.blendMode = 'multiply';
    contactShadow.alpha = 0.28;
    contactShadow.position.set(staticTilesOffsetPx.x, staticTilesOffsetPx.y + 1);

    const sunBeam = new Sprite(
      sunBeamTexture(widthPx * 0.55, [
        [0, 'rgba(255,210,120,0.72)'],
        [0.35, 'rgba(255,185,110,0.38)'],
        [0.6, 'rgba(255,170,120,0.14)'],
        [1, 'rgba(255,170,120,0)']
      ])
    );
    sunBeam.anchor.set(0.5);
    sunBeam.position.set(widthPx * 0.08, heightPx * 0.6);
    sunBeam.blendMode = 'screen';

    const glint = new Sprite(
      radialGradientTexture(widthPx * 0.35, [
        [0, 'rgba(255,208,150,0.25)'],
        [1, 'rgba(255,208,150,0)']
      ])
    );
    glint.anchor.set(0.5);
    glint.position.set(widthPx * 0.82, heightPx * 0.1);
    glint.blendMode = 'screen';

    const sunsetVignette = new Sprite(
      vignetteTexture(widthPx, heightPx, [
        [0, 'rgba(55,18,42,0)'],
        [1, 'rgba(55,18,42,0.5)']
      ])
    );
    sunsetVignette.blendMode = 'multiply';

    this.sunsetLayer.addChild(sunsetWash, contactShadow, sunBeam, glint, sunsetVignette);

    // ---- warm practical lights (night family — fade with night's own
    // weight, not sunset's; see KEYFRAMES' comment: lamps are lit only once
    // full night sets in, and fade out again through dawn) ----

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

  /** Recomputes which phase(s) are showing from local time (or the QA
   *  override) — cheap (a few multiplies), called once at mount and every
   *  60s after. Nothing here touches per-frame animation state. */
  private recompute(): void {
    const w = weightsAt(localHourNow());
    this.nightLayer.alpha = w.n;
    this.sunsetLayer.alpha = w.s;
    this.lampLayer.alpha = w.n;
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
  }
}
