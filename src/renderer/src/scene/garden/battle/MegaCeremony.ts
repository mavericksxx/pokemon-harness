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
const RING_SPARKS = 10;
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

interface RingSpark {
  g: Graphics;
  angle: number;
  speed: number;
}

export class MegaCeremony {
  private v = 0;
  private finished = false;
  private swapped = false;
  private flickerT = 0;
  private flickerIdx = 0;
  private glintT = 0;
  private glintIdx = 0;

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
  private readonly orbs: Orb[] = [];
  private readonly ring: RingSpark[] = [];
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
      const g = new Graphics();
      drawFlameShard(g, h * 0.62, w * 0.3);
      g.rotation = -Math.PI / 2; // fan upward from the feet
      g.x = (i === 0 ? -1 : 1) * w * 0.42;
      g.alpha = 0;
      this.plumes.push(g);
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

    for (let i = 0; i < RING_SPARKS; i++) {
      const g = new Graphics();
      const len = 3 + Math.random() * 3;
      g.rect(-len, -0.9, len * 2, 1.8).fill({ color: MAGENTA });
      g.rect(-len * 0.5, -0.4, len, 0.8).fill({ color: HOT });
      g.alpha = 0;
      this.ring.push({ g, angle: (i / RING_SPARKS) * Math.PI * 2, speed: 3.4 + Math.random() * 1.2 });
    }

    this.core = new Graphics();
    this.core.circle(0, 0, 11).fill({ color: VIOLET, alpha: 0.3 });
    this.core.circle(0, 0, 7).fill({ color: MAGENTA, alpha: 0.65 });
    this.core.circle(0, 0, 3.4).fill({ color: 0xffffff, alpha: 1 });
    this.core.y = torso;
    this.core.scale.set(0);

    this.glint = new Graphics();
    drawGlint(this.glint, GLINT_SIZES[0]);
    this.glint.alpha = 0;

    this.fx.addChild(
      ...this.plumes,
      this.silhouetteHolder,
      ...this.orbs.map((o) => o.g),
      ...this.ring.map((r) => r.g),
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

  /** The swirling energy ring: sparks tracing a perspective-squashed ellipse
   *  around the body, tangentially oriented, dimmed on the far half so the
   *  ring reads as arcing BEHIND the pokemon and back around the front. */
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
    for (const r of this.ring) {
      // Spins up as the vortex tightens — the pull-in is a speed change as
      // much as a radius one.
      r.angle += dt * r.speed * (1 + tighten * 2.2);
      const c = Math.cos(r.angle);
      const s = Math.sin(r.angle);
      r.g.x = c * rx;
      r.g.y = torso + s * ry;
      r.g.rotation = Math.atan2(ry * c, -rx * s);
      r.g.alpha = grow * fade * (s > 0 ? 1 : 0.35);
    }
  }

  /** Twin flame plumes at the feet, flaring on a stepped flicker. */
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
    const step = PLUME_STEPS[this.flickerIdx];
    for (const g of this.plumes) {
      g.alpha = alpha;
      // Consumed by the vortex along with everything else: the plumes shrink
      // toward the body as the pull-in starts.
      g.scale.set(step * lerp(1, 0.3, ramp(this.v, PULL_END - 300, CORE_END)));
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
