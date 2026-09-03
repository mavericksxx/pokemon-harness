/**
 * Mega Evolution's staged ceremony — the battle-only counterpart to
 * EvolutionCeremony.ts, reverse engineered from a real Mega Evolution cutscene
 * (orbs + dim -> silhouette/ring/plumes -> vortex pull-in -> hot core ->
 * flash-out burst -> settle glint) and cut down to something that reads at
 * ~40px in an ambient garden battle.
 *
 * WHAT IT DELIBERATELY DOES NOT BORROW FROM EvolutionCeremony:
 *  - No camera work (battles never drive the camera), and no full-map
 *    black/white overlay rects. That map-wide dim + flash-out is REAL
 *    evolution's signature; reusing it here would make a mega read as an
 *    ordinary evolution. Every dim/glow/flash below is sized off the sprite's
 *    own footprint instead (`spriteWidth`/`spriteHeight`), the same way
 *    battleFx.ts's `spawnHitFlash` sizes itself.
 *  - No literal crystal/shatter geometry: a faceted gem shell is noise at this
 *    scale. The ring, the flame plumes, the silhouette pull-in, the core and
 *    the flash-burst are what survive that translation.
 *
 * It DOES borrow EvolutionCeremony's shape: an authored timeline stepped by
 * `update(dt)`, per-instance graphics threaded in through a deps interface,
 * a `done` flag the owner polls, and a teardown/dispose split where dispose is
 * the "end it now WITHOUT performing the swap" path.
 *
 * ONE INSTANCE PER IN-FLIGHT MEGA, owned by the Walker (Walker.ts's
 * `megaCeremony`), which is also what ticks it and marks the frame dirty.
 * Two can run at once (two parents' subagent battles overlapping): every
 * graphic below is per-instance, created in the constructor and destroyed in
 * `teardown()` — the only shared thing touched is `flashLayer`, which the
 * flash-burst is added to and removed from, exactly the concurrency model
 * EvolutionCeremony's own file header describes.
 *
 * Timings are authored directly in real milliseconds (no `durationScale`
 * knob — unlike evolution, this beat isn't user-configurable) and total
 * ~3.6s, of which the caller holds its battle wave in place for the whole
 * duration (see BattleManager's `megaHold`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { silhouetteFrom } from '../EvolutionCeremony';
import type { WalkerSprite } from '../WalkerSprite';

// --- Authored timeline (ms from the ceremony's start) ---------------------
/** Beat 1: orbs pop in and drift up, the vicinity dims. */
const SPARK_END = 700;
/** The colored body has fully crossfaded into its silhouette by here. */
const BODY_FADE_END = 1000;
/** Beat 2: silhouette held, energy ring swirling, twin plumes flaring. */
const CHARGE_END = 1700;
/** Beat 3: the vortex pull-in — ring tightens, silhouette collapses inward. */
const PULL_END = 2500;
/** Beat 4: everything converged into one hot core, at peak. */
const CORE_END = 2750;
/** Beat 5: the flash-out burst — and the frame the sprite swap happens. */
const FLASH_END = 3050;
/** Beat 6: settle — glint above the head, residuals fade, battle resumes. */
const SETTLE_END = 3600;

const VIOLET = 0x8b2fd6;
const MAGENTA = 0xff3ea5;
const HOT = 0xfff0ff;
/** The silhouette is a near-white cutout (see `silhouetteFrom`) tinted down to
 *  this, rather than a second cutout pass in a different color. */
const SILHOUETTE_TINT = 0x1c0a2e;

const ORB_COUNT = 6;
const VORTEX_BLADES = 3;
const BURST_SHARDS = 9;
/** Discrete plume/glint sizes — a stepped flicker reads as pixel-art energy;
 *  a smoothly eased scale reads as a growing balloon (same reasoning as
 *  EvolutionCeremony's star twinkle and battleFx's shiny sparkle). */
const FLICKER_MS = 70;
const PLUME_STEPS = [0.72, 1, 0.86, 1.12];
const GLINT_SIZES = [1.5, 2.5, 3.5];
const GLINT_STEP_MS = 90;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** 0 -> 1 across [from, to], clamped. */
function ramp(v: number, from: number, to: number): number {
  return Math.max(0, Math.min(1, (v - from) / (to - from)));
}

/** Traces (moveTo/lineTo, NOT stroked) a squashed-ellipse arc from angle `a0`
 *  to `a1` into `g` — the shared path builder behind the ring's continuous
 *  glow, so the caller only has to pick a width/color and call `.stroke()`. */
function traceEllipseArc(
  g: Graphics,
  rx: number,
  ry: number,
  cy: number,
  a0: number,
  a1: number,
  segments: number
): void {
  for (let i = 0; i <= segments; i++) {
    const a = lerp(a0, a1, i / segments);
    const x = Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
}

/** One hard-edged "flame brush" wedge fanning out along +x from the origin —
 *  the poster-style graphic shape the reference cutscene fires outward at its
 *  flash-out, reused (rotated up) for the feet plumes so the two beats share
 *  one vocabulary. Three nested jagged polygons, deep violet -> magenta -> hot
 *  core: hard edges and flat fills, never a soft particle. */
function drawFlameShard(g: Graphics, len: number, width: number): void {
  for (const [scale, color] of [
    [1, VIOLET],
    [0.72, MAGENTA],
    [0.4, HOT]
  ] as const) {
    const l = len * scale;
    const w = width * scale;
    g.poly([0, 0, l * 0.34, -w * 0.55, l * 0.58, -w * 0.16, l, 0, l * 0.52, w * 0.3, l * 0.26, w * 0.6]).fill({
      color
    });
  }
}

/** One curved pinwheel "blade" swept `VORTEX_TURN` radians from a stub near the
 *  origin out to a tapered tip — the vortex's spiral motif (`updateVortex`
 *  rotates a small handful of these). Same nested wide/dim -> narrow/bright
 *  layering as `drawFlameShard`, but the points sweep along a curl instead of
 *  a straight fan, so a handful of them rotating together reads as a
 *  spinning pinwheel/whirlpool rather than more flame wedges. */
const VORTEX_TURN = 0.95;
function drawSpiralBlade(g: Graphics, len: number, width: number): void {
  const steps = 6;
  const outline = (s: number): number[] => {
    const pts: number[] = [];
    // Outer edge: stub -> tip, curling forward.
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = lerp(width * 0.2, len, t) * s;
      const a = t * VORTEX_TURN;
      pts.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    // Inner edge: tip -> stub, curling tighter and flaring wider near the
    // stub, giving the blade its taper.
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const r = lerp(width * 0.2, len * 0.8, t) * s;
      const a = t * VORTEX_TURN + 0.4 * (1 - t);
      pts.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    return pts;
  };
  for (const [scale, color] of [
    [1, VIOLET],
    [0.72, MAGENTA],
    [0.4, HOT]
  ] as const) {
    g.poly(outline(scale)).fill({ color });
  }
}

/** A small glowing orb — three concentric circles falling off in alpha, the
 *  same cheap stand-in for a blur EvolutionCeremony's bubbles and
 *  WalkerSprite's shadow both use (no filters/shaders: the renderer forbids
 *  compiling one). */
function drawOrb(g: Graphics, r: number): void {
  g.circle(0, 0, r * 1.7).fill({ color: VIOLET, alpha: 0.22 });
  g.circle(0, 0, r).fill({ color: MAGENTA, alpha: 0.55 });
  g.circle(0, 0, r * 0.45).fill({ color: 0xffffff, alpha: 0.95 });
}

/** Small white "+" glint — the mega-stone flourish above the head on the
 *  settle beat. Redrawn (not scaled) on each discrete size step. */
function drawGlint(g: Graphics, size: number): void {
  g.clear();
  g.rect(-size, -0.5, size * 2, 1).fill({ color: 0xffffff });
  g.rect(-0.5, -size, 1, size * 2).fill({ color: 0xffffff });
  g.rect(-size * 0.45, -size * 0.45, size * 0.9, size * 0.9).fill({ color: HOT });
}

export interface MegaCeremonyDeps {
  /** The walker's own container — everything except the flash-burst is added
   *  here, so it depth-sorts with the rest of the garden (the ceremony never
   *  reparents the walker: unlike evolution, a battle keeps its participants
   *  where the choreography put them). */
  container: Container;
  sprite: WalkerSprite;
  /** The shared overlay layer the flash-burst goes into, so its peak draws
   *  above every character regardless of depth-sort — the one beat that has
   *  to. Same layer Walker's own instant mega flash uses. */
  flashLayer: Container;
  /** Read live rather than captured once: the mega form can be a different
   *  size than the base, and the settle-beat glint sits above the NEW head. */
  spriteWidth: () => number;
  spriteHeight: () => number;
  /** The walker's feet in `flashLayer`'s coordinate space (both it and the
   *  character layer are children of the same content container). */
  feet: () => { x: number; y: number };
  /** Performs the real sheet/scale/stance swap — invoked exactly once, at the
   *  flash-out peak, mirroring how EvolutionCeremony calls its own `applySwap`
   *  mid-sequence rather than at construction. */
  applySwap: () => void;
}

interface Orb {
  g: Graphics;
  angle: number;
  radius: number;
  rise: number;
  drift: number;
}

export class MegaCeremony {
  private v = 0;
  private finished = false;
  private swapped = false;
  private flickerT = 0;
  private flickerIdx = 0;
  private glintT = 0;
  private glintIdx = 0;
  /** Rotation phase for the ring's bright sweeping arc (`updateRing`). */
  private ringSpin = 0;
  /** Rotation phase for the vortex blades (`updateVortex`). */
  private vortexSpin = 0;

  /** Behind the sprite (zIndex -1) so it darkens the ground and scenery the
   *  pokemon is standing against while the pokemon itself stays lit — the
   *  footprint-scaled stand-in for the reference's "environment dims". */
  private readonly dim: Graphics;
  /** Everything else, above the sprite. */
  private readonly fx: Container;
  private readonly silhouetteHolder: Container;
  private readonly silhouette: Sprite;
  private readonly core: Graphics;
  private readonly glint: Graphics;
  private readonly plumes: Graphics[] = [];
  private readonly plumesInner: Graphics[] = [];
  private readonly orbs: Orb[] = [];
  /** Continuous ring, redrawn every frame in `updateRing` — a wide/dim base
   *  glow plus a brighter sweeping arc, replacing the old discrete sparks. */
  private readonly ringGlow: Graphics;
  private readonly ringPulse: Graphics;
  /** The spiral/pinwheel blades that ignite at the torso during the pull-in
   *  (`updateVortex`) — the vortex motif the reference cutscene has and the
   *  shipped build didn't. */
  private readonly vortexBlades: Graphics[] = [];
  /** Lives in the SHARED flashLayer, so teardown must remove it explicitly —
   *  it is the one graphic here that would otherwise outlive the walker. */
  private burst: Container | null = null;
  private burstDisc: Graphics | null = null;
  private burstShards: Graphics[] = [];

  constructor(private deps: MegaCeremonyDeps) {
    const w = deps.spriteWidth();
    const h = deps.spriteHeight();
    const torso = -h * 0.55;

    this.dim = new Graphics();
    for (const [s, alpha] of [
      [1.3, 0.12],
      [1.12, 0.16],
      [1, 0.24]
    ] as const) {
      this.dim.ellipse(0, -h * 0.35, w * 1.1 * s, h * 0.55 * s).fill({ color: 0x140320, alpha });
    }
    this.dim.alpha = 0;
    this.dim.zIndex = -1;

    this.fx = new Container();
    this.fx.zIndex = 99998;

    // Scaling the HOLDER (parked at the torso) is what makes the pull-in
    // collapse toward the chest rather than toward the feet; the silhouette
    // inside it carries the compensating offset so its own feet still land on
    // the ground.
    this.silhouetteHolder = new Container();
    this.silhouetteHolder.y = torso;
    this.silhouette = new Sprite(silhouetteFrom(deps.sprite.displayedFrameTexture));
    this.silhouette.anchor.set(0.5, 1);
    const scale = deps.sprite.drawnScale;
    this.silhouette.scale.set(deps.sprite.currentFacing === 'left' ? scale : -scale, scale);
    this.silhouette.tint = SILHOUETTE_TINT;
    this.silhouette.alpha = 0;
    this.silhouette.y = -torso;
    this.silhouetteHolder.addChild(this.silhouette);

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? -1 : 1;
      // Outer wing: big reach and spread, leaning outward — the bold flaring
      // "wings" that dominate a real portion of the reference frame.
      const outer = new Graphics();
      drawFlameShard(outer, h * 0.95, w * 0.62);
      outer.rotation = -Math.PI / 2 + sign * 0.28;
      outer.x = sign * w * 0.46;
      outer.alpha = 0;
      this.plumes.push(outer);

      // Inner tongue: smaller, more upright, flickers on an offset phase
      // (`updatePlumes`) so the wing reads as having internal movement
      // rather than being one rigid wedge.
      const inner = new Graphics();
      drawFlameShard(inner, h * 0.6, w * 0.32);
      inner.rotation = -Math.PI / 2 + sign * 0.12;
      inner.x = sign * w * 0.28;
      inner.alpha = 0;
      this.plumesInner.push(inner);
    }

    for (let i = 0; i < ORB_COUNT; i++) {
      const g = new Graphics();
      drawOrb(g, 1.2 + Math.random() * 1.4);
      g.alpha = 0;
      this.orbs.push({
        g,
        angle: (i / ORB_COUNT) * Math.PI * 2 + Math.random() * 0.5,
        radius: w * (0.35 + Math.random() * 0.3),
        rise: h * (0.5 + Math.random() * 0.6),
        drift: 0.6 + Math.random() * 0.8
      });
    }

    // Redrawn from scratch every frame in updateRing (its geometry — radius,
    // squash, sweep angle — changes continuously), so nothing to draw yet.
    this.ringGlow = new Graphics();
    this.ringPulse = new Graphics();

    for (let i = 0; i < VORTEX_BLADES; i++) {
      const g = new Graphics();
      drawSpiralBlade(g, h * 0.55, w * 0.24);
      g.y = torso;
      g.alpha = 0;
      this.vortexBlades.push(g);
    }

    this.core = new Graphics();
    // Six layers stepping down fast (vs. the old three), plus a hard bright
    // rim stroke — reads as a dense, almost-solid glow with a crisp edge
    // instead of a soft diffuse ball.
    this.core.circle(0, 0, 13).fill({ color: VIOLET, alpha: 0.22 });
    this.core.circle(0, 0, 10).fill({ color: VIOLET, alpha: 0.42 });
    this.core.circle(0, 0, 8).fill({ color: MAGENTA, alpha: 0.6 });
    this.core.circle(0, 0, 6.2).fill({ color: MAGENTA, alpha: 0.88 });
    this.core.circle(0, 0, 4.4).fill({ color: HOT, alpha: 0.96 });
    this.core.circle(0, 0, 2.6).fill({ color: 0xffffff, alpha: 1 });
    this.core.circle(0, 0, 12.6).stroke({ width: 1.3, color: HOT, alpha: 0.85 });
    this.core.y = torso;
    this.core.scale.set(0);

    this.glint = new Graphics();
    drawGlint(this.glint, GLINT_SIZES[0]);
    this.glint.alpha = 0;

    this.fx.addChild(
      ...this.plumes,
      ...this.plumesInner,
      this.silhouetteHolder,
      ...this.vortexBlades,
      ...this.orbs.map((o) => o.g),
      this.ringGlow,
      this.ringPulse,
      this.core,
      this.glint
    );
    deps.container.addChild(this.dim, this.fx);
  }

  get done(): boolean {
    return this.finished;
  }

  update(dt: number): void {
    if (this.finished) return;
    this.v += dt * 1000;

    this.updateDim();
    this.updateOrbs(dt);
    this.updateRing(dt);
    this.updateVortex(dt);
    this.updatePlumes(dt);
    this.updateSilhouette();
    this.updateCore();

    if (this.v >= CORE_END && !this.swapped) this.startFlash();
    if (this.burst) this.updateBurst();
    if (this.v >= FLASH_END) this.updateSettle(dt);
    if (this.v >= SETTLE_END) this.teardown();
  }

  // --- Beats ---------------------------------------------------------------

  private updateDim(): void {
    // Ramps in over the first beat, holds through the core peak, then is
    // washed out by the flash itself rather than lingering under it.
    this.dim.alpha =
      this.v < CORE_END ? ramp(this.v, 0, SPARK_END * 0.8) : 1 - ramp(this.v, CORE_END, FLASH_END);
  }

  /** Beat 1 (pop in, drift up) into beat 3 (converge into the core). */
  private updateOrbs(dt: number): void {
    const w = this.deps.spriteWidth();
    const torso = -this.deps.spriteHeight() * 0.55;
    const pull = ramp(this.v, PULL_END - 500, CORE_END);
    for (const o of this.orbs) {
      o.angle += dt * o.drift;
      const rise = -o.rise * Math.min(1, this.v / CHARGE_END);
      const x = Math.cos(o.angle) * o.radius;
      const y = rise + Math.sin(o.angle * 1.7) * w * 0.1;
      o.g.x = lerp(x, 0, pull);
      o.g.y = lerp(y, torso, pull);
      // Consumed by the flash rather than left hanging over the newly revealed
      // mega form.
      o.g.alpha = ramp(this.v, 0, 260) * (1 - ramp(this.v, CORE_END, CORE_END + 120));
    }
  }

  /** The swirling energy ring: a continuous glowing arc traced fresh every
   *  frame around a perspective-squashed ellipse — a wide/dim violet pass
   *  plus a narrower/brighter magenta pass (the same nested-layer technique
   *  `drawFlameShard` uses for the plumes), instead of gapped particles. A
   *  brighter arc segment sweeps around it (`ringSpin`) to carry the
   *  spin-up cue the old per-spark rotation gave. Both halves of the loop
   *  dim on the far side so the ring still reads as arcing BEHIND the
   *  pokemon and back around the front. */
  private updateRing(dt: number): void {
    const w = this.deps.spriteWidth();
    const torso = -this.deps.spriteHeight() * 0.55;
    const grow = ramp(this.v, SPARK_END * 0.5, CHARGE_END);
    const tighten = ramp(this.v, PULL_END - 600, CORE_END);
    // After the flash the survivors drift back OUT as residual embers rather
    // than staying clamped on the chest — the reference's settle beat.
    const release = ramp(this.v, CORE_END, SETTLE_END - 150);
    const rx = w * lerp(lerp(0.85, 0.16, tighten), 0.62, release) * grow;
    const ry = rx * 0.34;
    const fade = 1 - ramp(this.v, CORE_END + 100, SETTLE_END - 200);
    const envelope = grow * fade;

    // Spins up as the vortex tightens — the pull-in is a speed change as
    // much as a radius one.
    this.ringSpin += dt * (3.6 + tighten * 7);

    this.ringGlow.clear();
    if (envelope > 0.001) {
      // Front half (near the flame plumes) traces bright; the back half —
      // arcing behind the body — stays dimmed, same cue the old per-spark
      // `s > 0 ? 1 : 0.35` gave.
      for (const [a0, a1, depth] of [
        [0, Math.PI, 1],
        [Math.PI, Math.PI * 2, 0.35]
      ] as const) {
        traceEllipseArc(this.ringGlow, rx, ry, torso, a0, a1, 20);
        this.ringGlow.stroke({
          width: Math.max(1, w * 0.1),
          color: VIOLET,
          alpha: envelope * depth * 0.35,
          cap: 'round',
          join: 'round'
        });
        traceEllipseArc(this.ringGlow, rx, ry, torso, a0, a1, 20);
        this.ringGlow.stroke({
          width: Math.max(0.6, w * 0.045),
          color: MAGENTA,
          alpha: envelope * depth * 0.75,
          cap: 'round',
          join: 'round'
        });
      }
    }

    this.ringPulse.clear();
    if (envelope > 0.001) {
      const a0 = this.ringSpin - 1.15;
      const a1 = this.ringSpin + 1.15;
      const wrapped = ((this.ringSpin % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const depth = Math.sin(wrapped) > 0 ? 1 : 0.35;
      traceEllipseArc(this.ringPulse, rx, ry, torso, a0, a1, 16);
      this.ringPulse.stroke({
        width: Math.max(0.8, w * 0.06),
        color: MAGENTA,
        alpha: envelope * depth * 0.7,
        cap: 'round',
        join: 'round'
      });
      traceEllipseArc(this.ringPulse, rx, ry, torso, a0, a1, 16);
      this.ringPulse.stroke({
        width: Math.max(0.4, w * 0.026),
        color: HOT,
        alpha: envelope * depth * 0.9,
        cap: 'round',
        join: 'round'
      });
    }
  }

  /** The vortex pull-in's missing element: a small pinwheel of curved
   *  "blade" shapes igniting at the torso and rotating, growing as the
   *  silhouette collapses so it visually consumes it — the reference's
   *  distinct spiral/whirlpool motif, absent from the previous build (which
   *  only had a shrinking ring and a scaling-down silhouette). Tied to the
   *  same `PULL_END - 700 -> CORE_END` window `updateSilhouette`'s collapse
   *  and `updateCore`'s grow already use, so all three converge together. */
  private updateVortex(dt: number): void {
    const t = ramp(this.v, PULL_END - 700, CORE_END);
    this.vortexSpin += dt * (4 + t * 10);
    const scale = lerp(0.12, 1, t) * (this.deps.spriteWidth() / 34 + 0.5);
    // Blown out by the core/flash the same way the ring and plumes are.
    const alpha = t < 1 ? t : 1 - ramp(this.v, CORE_END, CORE_END + 140);
    for (let i = 0; i < this.vortexBlades.length; i++) {
      const g = this.vortexBlades[i];
      g.rotation = this.vortexSpin + (i / this.vortexBlades.length) * Math.PI * 2;
      g.scale.set(scale);
      g.alpha = alpha;
    }
  }

  /** Twin flame wings at the feet, flaring on a stepped flicker — an outer
   *  wing (big reach and spread) plus a smaller inner tongue per side on an
   *  offset flicker phase, so each wing reads as having internal flicker
   *  rather than being one rigid wedge. */
  private updatePlumes(dt: number): void {
    this.flickerT += dt * 1000;
    if (this.flickerT >= FLICKER_MS) {
      this.flickerT -= FLICKER_MS;
      this.flickerIdx = (this.flickerIdx + 1) % PLUME_STEPS.length;
    }
    const alpha =
      this.v < PULL_END
        ? ramp(this.v, SPARK_END * 0.7, CHARGE_END * 0.9)
        : 1 - ramp(this.v, PULL_END, CORE_END);
    // Consumed by the vortex along with everything else: the wings shrink
    // toward the body as the pull-in starts.
    const collapse = lerp(1, 0.3, ramp(this.v, PULL_END - 300, CORE_END));
    const outerStep = PLUME_STEPS[this.flickerIdx];
    const innerStep = PLUME_STEPS[(this.flickerIdx + 2) % PLUME_STEPS.length];
    for (const g of this.plumes) {
      g.alpha = alpha;
      g.scale.set(outerStep * collapse);
    }
    for (const g of this.plumesInner) {
      g.alpha = alpha;
      g.scale.set(innerStep * collapse);
    }
  }

  /** Beat 2 (crossfade the colored body into a silhouette) and beat 3 (the
   *  silhouette collapsing into the torso). */
  private updateSilhouette(): void {
    if (this.swapped) return;
    const t = ramp(this.v, SPARK_END, BODY_FADE_END);
    this.deps.sprite.setBodyAlpha(1 - t);
    const collapse = ramp(this.v, PULL_END - 700, CORE_END);
    this.silhouette.alpha = t * (1 - collapse);
    // Track the body's own lift/bob so the silhouette sits exactly on it.
    this.silhouette.y = this.deps.sprite.bodyOffsetY - this.silhouetteHolder.y;
    // Squeezed horizontally harder than vertically — a vortex pulling the
    // shape into a column before it goes, not a uniform shrink.
    this.silhouetteHolder.scale.set(lerp(1, 0.28, collapse), lerp(1, 0.55, collapse));
  }

  /** Beat 4: everything converged into one hot core at peak intensity — then
   *  blown out by the flash-burst rather than left sitting over the revealed
   *  mega form. */
  private updateCore(): void {
    const grow = ramp(this.v, PULL_END - 700, CORE_END);
    const blowout = ramp(this.v, CORE_END, CORE_END + 140);
    const pulse = 1 + Math.sin(this.v * 0.02) * 0.08 * grow;
    this.core.scale.set(grow * pulse * (this.deps.spriteWidth() / 34 + 0.5) * (1 + blowout * 0.7));
    this.core.alpha = grow * (1 - blowout);
  }

  /**
   * Beat 5 — the flash-out. THIS is the frame the mega form actually appears:
   * the swap is hidden inside the burst's first frames, the same "swap exactly
   * at the flash peak" convention Walker's own instant mega flash and
   * EvolutionCeremony's reveal both use.
   */
  private startFlash(): void {
    this.swapped = true;
    this.silhouette.visible = false;
    this.deps.applySwap();
    this.deps.sprite.setBodyAlpha(1);

    const h = this.deps.spriteHeight();
    const w = this.deps.spriteWidth();
    const torso = -h * 0.55;
    const burst = new Container();
    const feet = this.deps.feet();
    burst.x = feet.x;
    burst.y = feet.y;

    const disc = new Graphics();
    disc.circle(0, torso, Math.max(w, h) * 0.42).fill({ color: 0xffffff, alpha: 0.9 });
    disc.circle(0, torso, Math.max(w, h) * 0.26).fill({ color: 0xffffff, alpha: 1 });
    burst.addChild(disc);
    this.burstDisc = disc;

    this.burstShards = [];
    for (let i = 0; i < BURST_SHARDS; i++) {
      const g = new Graphics();
      drawFlameShard(g, h * (0.42 + Math.random() * 0.3), w * 0.26);
      g.rotation = (i / BURST_SHARDS) * Math.PI * 2 + Math.random() * 0.25;
      g.y = torso;
      burst.addChild(g);
      this.burstShards.push(g);
    }
    this.deps.flashLayer.addChild(burst);
    this.burst = burst;
  }

  private updateBurst(): void {
    const burst = this.burst;
    if (!burst) return;
    const t = ramp(this.v, CORE_END, FLASH_END);
    const feet = this.deps.feet();
    burst.x = feet.x;
    burst.y = feet.y;
    const torso = -this.deps.spriteHeight() * 0.55;
    if (this.burstDisc) {
      this.burstDisc.scale.set(lerp(0.35, 1.7, t));
      this.burstDisc.alpha = 1 - t * t;
    }
    for (const shard of this.burstShards) {
      const reach = lerp(0.15, 1, t);
      shard.x = Math.cos(shard.rotation) * this.deps.spriteWidth() * 0.7 * reach;
      shard.y = torso + Math.sin(shard.rotation) * this.deps.spriteHeight() * 0.4 * reach;
      shard.scale.set(lerp(0.5, 1.35, t));
      shard.alpha = 1 - t;
    }
    if (t >= 1) {
      burst.destroy({ children: true });
      this.burst = null;
      this.burstDisc = null;
      this.burstShards = [];
    }
  }

  /** Beat 6: a mega-stone glint above the head while the residuals fade out
   *  and the battle stance resumes underneath. */
  private updateSettle(dt: number): void {
    this.glintT += dt * 1000;
    if (this.glintT >= GLINT_STEP_MS) {
      this.glintT -= GLINT_STEP_MS;
      this.glintIdx = (this.glintIdx + 1) % GLINT_SIZES.length;
      drawGlint(this.glint, GLINT_SIZES[this.glintIdx]);
    }
    const t = ramp(this.v, FLASH_END, SETTLE_END);
    this.glint.x = this.deps.spriteWidth() * 0.3;
    this.glint.y = -this.deps.spriteHeight() * 1.02;
    this.glint.alpha = t < 0.25 ? t / 0.25 : Math.max(0, 1 - (t - 0.25) / 0.75);
  }

  // --- Lifecycle -----------------------------------------------------------

  private teardown(): void {
    if (this.finished) return;
    this.finished = true;
    // Restore the body on BOTH the completed and the aborted path: the
    // silhouette beat fades it to 0, and nothing else in the app would ever
    // put it back — an abort mid-silhouette would otherwise leave the parent
    // walker permanently invisible. (Same reasoning as EvolutionCeremony's own
    // teardown.)
    this.deps.sprite.setBodyAlpha(1);
    this.burst?.destroy({ children: true });
    this.burst = null;
    this.burstDisc = null;
    this.burstShards = [];
    this.dim.destroy();
    this.fx.destroy({ children: true });
  }

  /** Force-end WITHOUT performing the swap — the abort path, used when the
   *  battle ends (or the walker is torn down, or an evolution ceremony seizes
   *  the sprite) before the flash peak. Once `applied` is true the swap has
   *  already happened and the caller reverts it the normal way instead. */
  dispose(): void {
    this.teardown();
  }
}
