/**
 * The evolution ceremony: the authentic game beat (flash-in → silhouette →
 * accelerating old/new-form oscillation → lock → flash-out reveal), reverse
 * engineered frame-by-frame from real game footage. Replaces the old ~2s
 * flash/pulse/sparkle in Walker.evolve().
 *
 * All timings below are authored at `durationScale === 1.0` (~15s total); the
 * ceremony scales real elapsed ms into this "virtual" timeline by dividing by
 * `durationScale`, so a smaller scale (the default, 0.6) plays it back faster
 * and a larger one slows it down.
 *
 * One instance per in-flight evolution. Two can run concurrently (one per
 * walker) without conflict: each owns its own dim/flash overlay graphics
 * (added to, and removed from, the scene's shared `dimLayer`/`flashLayer`)
 * and reparents only its own walker into the shared `ceremonyLayer`. Dims and
 * flashes live in separate layers (flash always drawn above every dim) so one
 * ceremony's flash-out is never visually crushed by another's still-active
 * dim — Pixi composites siblings back-to-front, so two dims sharing one layer
 * with a flash would otherwise occlude it whenever the dim was added later.
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Facing, WalkerSprite } from './WalkerSprite';
import type { PokemonAnimation } from './showdownArt';
import { spriteScale } from './spriteScale';
import {
  notifyEvolutionStart,
  notifyEvolutionFlash,
  notifyEvolutionEnd,
  playEvolutionCry
} from '@/audio/audioEngine';

// --- Authored timeline (ms at durationScale 1.0) ---------------------------
const HALT_END = 1000;
const CROSSFADE_END = 1800;
const RAY_START = 2500;
const RAY_END = 2830;
const STATIC_END = 4000;
const OSC_BAND1_END = 6000;
const OSC_BAND2_END = 9000;
const OSC_END = 10830;
const BUBBLES_FADE_IN_START = 10000;
const LOCK_END = 11750;
const FLASH_END = 12000;
const FLASH_HOLD_END = 12550;
const DECAY_STEP_MS = 250;
const DECAY_STEPS = [212, 175, 142, 109, 79, 49, 23, 0];
const DECAY_END = FLASH_HOLD_END + DECAY_STEP_MS * DECAY_STEPS.length;
const FLASH_STEPS = [0, 23, 49, 109, 142, 212, 247];

const SILHOUETTE_COLOR = 0xf7f7f7; // rgb(247,247,247)
const OVERLAY_ALPHA = 0.85;

const BUBBLE_COUNT = 7;
const STAR_COUNT = 20;
/** Discrete plus-sign half-lengths a starfield sparkle steps through — see
 *  makeStar()/updateTwinkle(). */
const STAR_SIZES = [1.5, 2.5, 3.5];
/** How often (ms) a star re-rolls its size — the "twinkle" cadence. */
const STAR_TWINKLE_MS = 120;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** Flat rgb(247,247,247) cutout of a frame's alpha shape, via plain canvas 2D
 *  compositing — no filters/shaders needed (frame textures already carry
 *  their native-sheet sub-rectangle in `.frame`, and their raw image in
 *  `.source.resource`, so this never touches the GPU renderer). Cached per
 *  source frame texture so re-evolving the same species doesn't redo it. */
const silhouetteCache = new WeakMap<Texture, Texture>();

function silhouetteFrom(frameTexture: Texture): Texture {
  const cached = silhouetteCache.get(frameTexture);
  if (cached) return cached;
  const { x, y, width, height } = frameTexture.frame;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return frameTexture;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    frameTexture.source.resource as CanvasImageSource,
    x,
    y,
    width,
    height,
    0,
    0,
    width,
    height
  );
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = 'rgb(247, 247, 247)';
  ctx.fillRect(0, 0, width, height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  silhouetteCache.set(frameTexture, texture);
  return texture;
}

/** One form's silhouette sprite, sized/mirrored exactly as the real body
 *  would be — so swapping forms (or swapping back to the real sprite at the
 *  end) never shifts the feet. */
function makeSilhouetteSprite(animation: PokemonAnimation, tileSize: number, facing: Facing): Sprite {
  const texture = silhouetteFrom(animation.front.frames[0].texture);
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 1);
  const scale = spriteScale(animation.info.name, animation.front.frameHeight, tileSize);
  sprite.scale.set(facing === 'left' ? scale : -scale, scale);
  return sprite;
}

/** Small SOFT round particle used for both the feet-orbit bubbles and the
 *  flash-hold rain — three concentric circles falling off in alpha, the same
 *  cheap stand-in for a blur WalkerSprite's shadow uses (no filters/shaders). */
function makeBubble(): Graphics {
  const r = 2 + Math.random() * 3; // 4-10px across
  const g = new Graphics();
  g.circle(0, 0, r * 1.4).fill({ color: 0xffffff, alpha: 0.18 });
  g.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.4 });
  g.circle(0, 0, r * 0.55).fill({ color: 0xffffff, alpha: 0.9 });
  return g;
}

/** Small white "+" twinkle. Renders at one of three fixed sizes rather than a
 *  continuously-scaled one — see updateTwinkle(): a smoothly scaling
 *  plus-sign doesn't read as a GBA-style twinkle, a snappy 3-frame cycle does. */
function makeStar(size: number): Graphics {
  const g = new Graphics();
  g.rect(-size, -0.5, size * 2, 1).fill({ color: 0xffffff, alpha: 1 });
  g.rect(-0.5, -size, 1, size * 2).fill({ color: 0xffffff, alpha: 1 });
  return g;
}

export interface CeremonyDeps {
  /** The walker's own container — reparented into `ceremonyLayer` for the
   *  ceremony's duration, then back to its original parent. */
  container: Container;
  sprite: WalkerSprite;
  newAnimation: PokemonAnimation;
  /** Dex id of the evolved species — for its cry at the reveal (Phase 7),
   *  distinct from `toLabel`'s display name. */
  toId: string;
  tileSize: number;
  /** Where each ceremony's dim (black) overlay goes — shared, so with two
   *  ceremonies running at once, both dims stack; kept BELOW flashLayer so
   *  neither ceremony's flash-out is ever crushed by the other's still-active
   *  dim (they'd otherwise composite in call order, since Pixi draws children
   *  back-to-front — see the concurrency note above). */
  dimLayer: Container;
  /** Where each ceremony's flash (white) overlay goes — shared, always above
   *  dimLayer. */
  flashLayer: Container;
  ceremonyLayer: Container;
  /** Full map size in world pixels, so the dim/flash overlay covers whatever
   *  the camera could possibly show. */
  mapWidthPx: number;
  mapHeightPx: number;
  durationScale: number;
  /** Feet-relative size, for scaling how far particles roam. */
  spriteWidth: number;
  spriteHeight: number;
  spawnText: (text: string) => void;
  /** Hide/restore the name tag, status badge and selection ring — the games'
   *  ceremony shows nothing but the Pokemon and its floating text. */
  setChromeHidden: (hidden: boolean) => void;
  fromLabel: string;
  toLabel: string;
  /** Performs the actual sheet/scale/locomotion swap Walker already does
   *  outside the ceremony (setAnimation + the session-store callback) —
   *  reused here so the reveal is the same code path as before. */
  applySwap: () => void;
}

interface Bubble {
  g: Graphics;
  angle: number;
  radius: number;
  speed: number;
  // Rain-mode state, set once when the flash phase begins.
  rainX?: number;
  rainVy?: number;
}

export class EvolutionCeremony {
  private v = 0; // virtual elapsed ms, see file header
  private finished = false;

  private readonly originalParent: Container | null;
  private readonly blackOverlay: Graphics;
  private readonly whiteOverlay: Graphics;
  private readonly bubbleLayer: Container;
  private readonly blobContainer: Container;
  private readonly rayLayer: Container;
  private readonly starLayer: Container;

  private oldSilhouette: Sprite;
  private newSilhouette: Sprite;
  private bubbles: Bubble[] = [];
  private stars: { g: Graphics; sizeIdx: number; timer: number }[] = [];

  private crossfadeStarted = false;
  private rayBurstSpawned = false;
  private oscStarted = false;
  private oscForm: 'old' | 'new' = 'old';
  private oscCycleElapsed = 0;
  private oscCycleDur = 500;
  private oscBlobScale = 1;
  private oscSwappedThisCycle = false;
  private rainStarted = false;
  private starsSpawned = false;
  private swapped = false;
  private flashMusicStarted = false;

  constructor(private deps: CeremonyDeps) {
    this.originalParent = deps.container.parent;
    deps.ceremonyLayer.addChild(deps.container);

    this.blackOverlay = new Graphics()
      .rect(0, 0, deps.mapWidthPx, deps.mapHeightPx)
      .fill({ color: 0x000000, alpha: 1 });
    this.blackOverlay.alpha = OVERLAY_ALPHA;
    this.whiteOverlay = new Graphics()
      .rect(0, 0, deps.mapWidthPx, deps.mapHeightPx)
      .fill({ color: SILHOUETTE_COLOR, alpha: 1 });
    this.whiteOverlay.alpha = 0;
    this.whiteOverlay.visible = false;
    deps.dimLayer.addChild(this.blackOverlay);
    deps.flashLayer.addChild(this.whiteOverlay);

    this.bubbleLayer = new Container();
    this.blobContainer = new Container();
    this.rayLayer = new Container();
    this.starLayer = new Container();
    deps.container.addChild(this.bubbleLayer, this.blobContainer, this.rayLayer, this.starLayer);

    const facing = deps.sprite.currentFacing;
    this.oldSilhouette = makeSilhouetteSprite(deps.sprite.animation, deps.tileSize, facing);
    this.newSilhouette = makeSilhouetteSprite(deps.newAnimation, deps.tileSize, facing);
    this.oldSilhouette.alpha = 0;
    this.newSilhouette.visible = false;
    this.blobContainer.addChild(this.oldSilhouette, this.newSilhouette);
    // Hidden until the crossfade phase — the halt phase (0-1000ms) still
    // shows the normal colored sprite.
    this.blobContainer.visible = false;

    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const g = makeBubble();
      g.alpha = 0;
      this.bubbleLayer.addChild(g);
      this.bubbles.push({
        g,
        angle: (i / BUBBLE_COUNT) * Math.PI * 2,
        radius: deps.spriteWidth * (0.25 + Math.random() * 0.2),
        speed: 1.2 + Math.random() * 0.6
      });
    }

    // Face the camera before anything else: a walker mid-upward-walk halts on
    // its back sheet, and evolving with its back turned reads badly. The
    // silhouettes below already force front frames regardless, but the
    // colored sprite visible through halt/crossfade needs the same turn.
    deps.sprite.setBackView(false);
    deps.sprite.freeze(true);
    deps.setChromeHidden(true);
    deps.spawnText(`What? ${deps.fromLabel} is evolving!`);
    notifyEvolutionStart();
  }

  get done(): boolean {
    return this.finished;
  }

  update(dt: number): void {
    if (this.finished) return;
    this.v += (dt * 1000) / this.deps.durationScale;

    this.updateBubbles(dt);

    if (this.v < HALT_END) {
      // Just standing there, halted, above the overlay — nothing else to do.
    } else if (this.v < CROSSFADE_END) {
      this.phaseCrossfade();
    } else if (this.v < STATIC_END) {
      this.phaseStaticHold();
    } else if (this.v < OSC_END) {
      this.phaseOscillate(dt);
    } else if (this.v < LOCK_END) {
      this.phaseLock();
    } else if (this.v < FLASH_END) {
      this.phaseFlashAttack();
    } else if (this.v < FLASH_HOLD_END) {
      this.phaseFlashHold();
    } else if (this.v < DECAY_END) {
      this.phaseDecay(dt);
    } else {
      this.finish();
    }
  }

  // --- Phases --------------------------------------------------------------

  private phaseCrossfade(): void {
    if (!this.crossfadeStarted) {
      this.crossfadeStarted = true;
      this.blobContainer.visible = true;
    }
    const t = (this.v - HALT_END) / (CROSSFADE_END - HALT_END);
    this.deps.sprite.setBodyAlpha(1 - t);
    this.oldSilhouette.alpha = t;
  }

  private phaseStaticHold(): void {
    this.deps.sprite.setBodyAlpha(0);
    this.oldSilhouette.alpha = 1;

    if (!this.rayBurstSpawned && this.v >= RAY_START) {
      this.rayBurstSpawned = true;
      this.spawnRayBurst();
    }
    if (this.rayLayer.children.length > 0) {
      const t = Math.max(0, Math.min(1, (this.v - RAY_START) / (RAY_END - RAY_START)));
      for (const child of this.rayLayer.children) child.alpha = 1 - t;
      if (this.v >= RAY_END) {
        // Destroy each dash (not the layer itself — teardown() destroys that
        // once, at the end, along with the ceremony's other containers).
        for (const child of [...this.rayLayer.children]) child.destroy();
      }
    }
  }

  private spawnRayBurst(): void {
    const n = 8;
    const topY = -this.deps.spriteHeight;
    for (let i = 0; i < n; i++) {
      // Fan upward: angles clustered around straight up (-90deg).
      const angle = -Math.PI / 2 + (i / (n - 1) - 0.5) * (Math.PI * 0.8);
      const len = this.deps.spriteWidth * (0.35 + Math.random() * 0.25);
      const dash = new Graphics();
      dash.moveTo(0, 0).lineTo(Math.cos(angle) * len, Math.sin(angle) * len).stroke({
        width: 2,
        color: 0xffffff,
        alpha: 1
      });
      dash.x = 0;
      dash.y = topY;
      this.rayLayer.addChild(dash);
    }
  }

  /** A full shrink-then-pop cycle must span at least this many real frames —
   *  otherwise, at the strobe band's 30-70ms authored rate, dividing by a
   *  sub-1.0 durationScale (or running on a 60Hz display) can shrink a cycle
   *  below one frame's deltaMS, so shrink and pop never both get a frame and
   *  it reads as flicker/stutter instead of a strobe. Floored against the
   *  ticker's OWN deltaMS for this frame, not a hardcoded 16.7ms guess — see
   *  cycleDurationAt(). */
  private static readonly MIN_FRAMES_PER_CYCLE = 4;

  /** `dtMs` is the CURRENT frame's real deltaMS (from the ticker), used only
   *  to floor the cycle so it can't be faster than the display can show. */
  private cycleDurationAt(v: number, dtMs: number): number {
    let dur: number;
    if (v < OSC_BAND1_END) {
      dur = lerp(500, 300, (v - STATIC_END) / (OSC_BAND1_END - STATIC_END));
    } else if (v < OSC_BAND2_END) {
      dur = lerp(250, 150, (v - OSC_BAND1_END) / (OSC_BAND2_END - OSC_BAND1_END));
    } else {
      dur = lerp(70, 30, (v - OSC_BAND2_END) / (OSC_END - OSC_BAND2_END));
    }
    const floorRealMs = dtMs * EvolutionCeremony.MIN_FRAMES_PER_CYCLE;
    const floorVirtualMs = floorRealMs / this.deps.durationScale;
    return Math.max(dur, floorVirtualMs);
  }

  /** Linear scale for a blob whose AREA is 35-75% of full size (area = scale²
   *  for a uniform scale). */
  private pickBlobScale(): number {
    return Math.sqrt(0.35 + Math.random() * 0.4);
  }

  private phaseOscillate(dt: number): void {
    if (!this.oscStarted) {
      this.oscStarted = true;
      this.oscForm = 'old';
      this.oscCycleElapsed = 0;
      this.oscCycleDur = this.cycleDurationAt(STATIC_END, dt * 1000);
      this.oscBlobScale = this.pickBlobScale();
      this.oscSwappedThisCycle = false;
    }

    const dv = (dt * 1000) / this.deps.durationScale;
    this.oscCycleElapsed += dv;
    const phase = Math.min(1, this.oscCycleElapsed / this.oscCycleDur);

    let scale: number;
    if (phase < 0.5) {
      scale = lerp(1, this.oscBlobScale, phase / 0.5);
    } else {
      // Swap exactly once per cycle, right at the midpoint — not every frame
      // the phase spends past it.
      if (!this.oscSwappedThisCycle) {
        this.oscSwappedThisCycle = true;
        this.showOscForm(this.oscForm === 'old' ? 'new' : 'old');
      }
      scale = lerp(this.oscBlobScale, 1, (phase - 0.5) / 0.5);
    }
    // Stepped, pixel-crisp shrink — snap to eighths.
    const stepped = Math.round(scale * 8) / 8;
    this.blobContainer.scale.set(stepped);

    if (this.oscCycleElapsed >= this.oscCycleDur) {
      this.oscCycleElapsed = 0;
      this.oscCycleDur = this.cycleDurationAt(this.v, dt * 1000);
      this.oscBlobScale = this.pickBlobScale();
      this.oscSwappedThisCycle = false;
    }
  }

  private showOscForm(form: 'old' | 'new'): void {
    if (this.oscForm === form) return;
    this.oscForm = form;
    this.oldSilhouette.visible = form === 'old';
    this.newSilhouette.visible = form === 'new';
  }

  private phaseLock(): void {
    this.showOscForm('new');
    this.blobContainer.scale.set(1);
  }

  private phaseFlashAttack(): void {
    if (!this.flashMusicStarted) {
      this.flashMusicStarted = true;
      notifyEvolutionFlash();
    }
    this.blackOverlay.visible = false;
    this.whiteOverlay.visible = true;
    const t = (this.v - LOCK_END) / (FLASH_END - LOCK_END);
    const idx = Math.min(FLASH_STEPS.length - 1, Math.floor(t * (FLASH_STEPS.length - 1) + 1e-6));
    this.whiteOverlay.alpha = FLASH_STEPS[idx] / 255;
  }

  private phaseFlashHold(): void {
    this.whiteOverlay.alpha = FLASH_STEPS[FLASH_STEPS.length - 1] / 255;
    if (!this.rainStarted) {
      this.rainStarted = true;
      this.startRain();
    }
  }

  private startRain(): void {
    for (const b of this.bubbles) {
      b.rainX = (Math.random() - 0.5) * this.deps.spriteWidth;
      b.rainVy = 60 + Math.random() * 40;
      b.g.x = b.rainX;
      b.g.y = -this.deps.spriteHeight - Math.random() * 30;
      b.g.alpha = 0.9;
    }
  }

  private phaseDecay(dt: number): void {
    const stepIdx = Math.min(
      DECAY_STEPS.length - 1,
      Math.floor((this.v - FLASH_HOLD_END) / DECAY_STEP_MS)
    );
    this.whiteOverlay.alpha = DECAY_STEPS[stepIdx] / 255;

    if (!this.swapped) {
      this.swapped = true;
      this.blobContainer.visible = false;
      this.deps.applySwap();
      this.deps.sprite.setBodyAlpha(1);
      this.deps.sprite.freeze(false);
      playEvolutionCry(this.deps.toId);
    }
    if (!this.starsSpawned) {
      this.starsSpawned = true;
      this.spawnStars();
    }
    this.updateTwinkle(dt, stepIdx);
  }

  private spawnStars(): void {
    const spread = this.deps.spriteWidth * 2.5;
    for (let i = 0; i < STAR_COUNT; i++) {
      const x = (Math.random() - 0.5) * spread;
      const y = -this.deps.spriteHeight * (0.3 + Math.random() * 1.4);
      const sizeIdx = Math.floor(Math.random() * STAR_SIZES.length);
      const g = makeStar(STAR_SIZES[sizeIdx]);
      g.x = x;
      g.y = y;
      this.starLayer.addChild(g);
      // Desynced timers so stars don't all flip on the same frame.
      this.stars.push({ g, sizeIdx, timer: Math.random() * STAR_TWINKLE_MS });
    }
  }

  /** Twinkle IN PLACE: no drift (x/y never change after spawn), just a snappy
   *  discrete size/brightness change every ~120ms — a smoothly-eased scale
   *  reads as "growing balls," not the GBA's blocky twinkle. Redraws the
   *  Graphics only on the (infrequent) frame its size actually changes. */
  private updateTwinkle(dt: number, stepIdx: number): void {
    const dim = DECAY_STEPS[stepIdx] / DECAY_STEPS[0];
    for (const s of this.stars) {
      s.timer += dt * 1000;
      if (s.timer >= STAR_TWINKLE_MS) {
        s.timer -= STAR_TWINKLE_MS;
        const nextIdx = Math.floor(Math.random() * STAR_SIZES.length);
        if (nextIdx !== s.sizeIdx) {
          s.sizeIdx = nextIdx;
          const size = STAR_SIZES[nextIdx];
          s.g.clear();
          s.g.rect(-size, -0.5, size * 2, 1).fill({ color: 0xffffff, alpha: 1 });
          s.g.rect(-0.5, -size, 1, size * 2).fill({ color: 0xffffff, alpha: 1 });
        }
      }
      const brightness = 0.5 + (s.sizeIdx / (STAR_SIZES.length - 1)) * 0.5;
      s.g.alpha = dim * brightness;
    }
  }

  private updateBubbles(dt: number): void {
    const dv = (dt * 1000) / this.deps.durationScale;
    for (const b of this.bubbles) {
      if (this.v >= FLASH_END) {
        // Rain mode: fall and converge toward the sprite's centerline.
        if (b.rainVy !== undefined) {
          b.g.y += b.rainVy * dt;
          b.g.x = lerp(b.g.x, 0, 0.02);
          if (this.v >= FLASH_HOLD_END) {
            const fadeT = (this.v - FLASH_HOLD_END) / (DECAY_STEP_MS * 2);
            b.g.alpha = Math.max(0, 0.9 * (1 - fadeT));
          }
        }
        continue;
      }
      b.angle += dv * 0.003 * b.speed;
      b.g.x = Math.cos(b.angle) * b.radius;
      b.g.y = Math.sin(b.angle) * b.radius * 0.4;
      b.g.alpha = this.bubbleAlphaEnvelope();
    }
  }

  private bubbleAlphaEnvelope(): number {
    const v = this.v;
    if (v < HALT_END) return v / HALT_END;
    if (v < CROSSFADE_END) return 1 - (v - HALT_END) / (CROSSFADE_END - HALT_END);
    if (v < BUBBLES_FADE_IN_START) return 0;
    if (v < OSC_END) return (v - BUBBLES_FADE_IN_START) / (OSC_END - BUBBLES_FADE_IN_START);
    return 1;
  }

  private finish(): void {
    this.deps.spawnText(`Congratulations! Your ${this.deps.fromLabel} evolved into ${this.deps.toLabel}!`);
    this.teardown();
  }

  private teardown(): void {
    if (this.finished) return;
    this.finished = true;
    notifyEvolutionEnd(); // hands the music bus back to battle/ambient — runs on force-end too
    this.deps.setChromeHidden(false);
    this.blackOverlay.destroy();
    this.whiteOverlay.destroy();
    this.bubbleLayer.destroy({ children: true });
    this.blobContainer.destroy({ children: true });
    this.rayLayer.destroy({ children: true });
    this.starLayer.destroy({ children: true });
    if (this.originalParent && !this.deps.container.destroyed) {
      this.originalParent.addChild(this.deps.container);
    }
  }

  /** Force-ends the ceremony without playing out the remaining phases or
   *  performing the real-sprite swap — used when the walker itself is
   *  destroyed mid-ceremony, so its overlay doesn't outlive it. */
  dispose(): void {
    this.teardown();
  }
}
