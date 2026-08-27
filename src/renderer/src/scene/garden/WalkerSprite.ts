import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { FrameSet, Locomotion, PokemonAnimation } from './showdownArt';
import { spriteScale } from './spriteScale';

// Started as munder-difflin's CharacterSprite (→ shahar061/the-office), and kept
// its contract: a Container whose origin is the character's feet, plus
// setPosition/destroy. The insides are different, because Showdown sprites are
// idle animations rather than a 4-direction walk sheet — there is one loop, and
// direction is expressed by mirroring instead of by picking a row.

export type Facing = 'left' | 'right';

/**
 * Which way the art points before mirroring. Showdown's front sprites are drawn
 * facing slightly toward the camera's left, so a walker heading right is the one
 * that gets flipped.
 */
const NATIVE_FACING: Facing = 'left';

/** How far off the ground each locomotion floats, in pixels. */
const LIFT: Record<Locomotion, number> = { walk: 0, levitate: 10, fly: 16 };

/** Bob amplitude (px) and rate (rad/sec) per locomotion. Grounded Pokemon bob
 *  only while moving; floating ones never stop. */
const BOB: Record<Locomotion, { amplitude: number; rate: number; whileStill: boolean }> = {
  walk: { amplitude: 2, rate: 7, whileStill: false },
  levitate: { amplitude: 3, rate: 2.4, whileStill: true },
  fly: { amplitude: 4, rate: 2, whileStill: true }
};

export class WalkerSprite {
  readonly container: Container;
  private body: AnimatedSprite;
  private shadow: Graphics;
  private locomotion: Locomotion;
  private bobPhase = 0;
  private moving = false;
  private facing: Facing = NATIVE_FACING;
  private scale = 1;
  private tileSize: number;

  private frontFrames!: FrameSet;
  private backFrames?: FrameSet;
  private usingBack = false;
  /** The species currently configured, for the evolution ceremony's
   *  silhouette (it needs both the outgoing and incoming form's frame 0). */
  private currentAnimation!: PokemonAnimation;

  constructor(animation: PokemonAnimation, tileSize: number) {
    this.tileSize = tileSize;
    this.locomotion = animation.info.locomotion;
    this.container = new Container();

    this.shadow = new Graphics();
    this.body = new AnimatedSprite(animation.front.frames);
    // Feet at the origin: the walker's world position is its tile's bottom edge.
    // The sprite is far taller than a tile, so it overlaps the tiles above it —
    // which is exactly what the map's `furniture-above` canopies draw over.
    this.body.anchor.set(0.5, 1);
    // FrameObject `time` values are milliseconds at speed 1.
    this.body.animationSpeed = 1;
    this.body.play();

    this.container.addChild(this.shadow, this.body);
    this.configure(animation);
  }

  /**
   * (Re)configure for a species — used by the constructor and by evolution's
   * mid-flash sprite swap. Recomputes scale (a bigger stage reads bigger),
   * locomotion (lift/bob, and whether water crossing is allowed), and the
   * shadow, then resets to the front view.
   */
  configure(animation: PokemonAnimation): void {
    this.currentAnimation = animation;
    this.locomotion = animation.info.locomotion;
    // Scale is derived from the FRONT sheet only: front and back geometry
    // differ per species (e.g. Pikachu front 50x46, back 40x47), and rescaling
    // per view would make a walker visibly resize when it turns around.
    this.scale = spriteScale(animation.info.name, animation.front.frameHeight, this.tileSize);
    this.frontFrames = animation.front;
    this.backFrames = animation.back;
    this.usingBack = false;

    // The shadow stays on the ground while the body bobs and lifts above it,
    // which is what sells the float. Three stacked ellipses in place of a blur:
    // a filter would mean compiling a shader, and the renderer forbids eval.
    this.shadow.clear();
    // Sized off the DRAWN width, so it tracks the sprite rather than the sheet.
    const rx = this.frontFrames.frameWidth * this.scale * 0.3;
    const ry = rx * 0.38;
    for (const [s, alpha] of [
      [1.25, 0.06],
      [1.1, 0.1],
      [1, 0.22]
    ]) {
      this.shadow.ellipse(0, -ry * 0.5, rx * s, ry * s).fill({ color: 0x000000, alpha });
    }

    this.body.textures = this.frontFrames.frames;
    this.body.alpha = 1;
    this.shadow.alpha = 1;
    this.body.play();
    this.applyTransform();
  }

  /** Mirror to face the direction of travel. Vertical movement keeps the
   *  previous facing — there is no back view to turn to. */
  setFacing(facing: Facing): void {
    this.facing = facing;
    this.applyTransform();
  }

  get currentFacing(): Facing {
    return this.facing;
  }

  /** The species currently shown — the evolution ceremony needs this for the
   *  outgoing form's silhouette (the incoming form is the one it's evolving
   *  into, passed to it directly). */
  get animation(): PokemonAnimation {
    return this.currentAnimation;
  }

  /** Switch between the front and back sheet (Phase 3 §3: predominantly
   *  upward movement uses the back view). A no-op when the species has none —
   *  the front view is kept, which is the documented fallback. */
  setBackView(useBack: boolean): void {
    const target = useBack && this.backFrames ? this.backFrames : this.frontFrames;
    const targetIsBack = target === this.backFrames;
    if (targetIsBack === this.usingBack) return;
    this.usingBack = targetIsBack;
    this.body.textures = target.frames;
    this.body.play();
  }

  get hasBackView(): boolean {
    return !!this.backFrames;
  }

  /** Pause/resume the idle loop without touching visibility — the evolution
   *  ceremony freezes the walker in place the instant it halts. */
  freeze(frozen: boolean): void {
    if (frozen) this.body.stop();
    else this.body.play();
  }

  /** Fade the normal colored art in/out (1 = fully shown), for the ceremony's
   *  crossfade into a silhouette and its reveal back out of one. The shadow
   *  fades with it — a silhouette casting a normal shadow reads wrong. */
  setBodyAlpha(alpha: number): void {
    this.body.alpha = alpha;
    this.shadow.alpha = alpha;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
  }

  update(dt: number): void {
    const bob = BOB[this.locomotion];
    if (this.moving || bob.whileStill) {
      this.bobPhase += dt * bob.rate;
      this.applyTransform();
    } else if (this.body.y !== -LIFT[this.locomotion]) {
      this.bobPhase = 0;
      this.applyTransform();
    }
  }

  private applyTransform(): void {
    const bob = BOB[this.locomotion];
    const riding = this.moving || bob.whileStill;
    this.body.y = -LIFT[this.locomotion] - (riding ? Math.abs(Math.sin(this.bobPhase)) * bob.amplitude : 0);
    this.body.scale.x = this.facing === NATIVE_FACING ? this.scale : -this.scale;
    this.body.scale.y = this.scale;
  }

  /** Drawn size in world pixels, for hit areas and bubble placement. */
  get drawnWidth(): number {
    return this.body.width;
  }
  get drawnHeight(): number {
    return this.body.height + LIFT[this.locomotion];
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
