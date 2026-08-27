import { AnimatedSprite, Container, Graphics, Sprite, Texture } from 'pixi.js';
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
  /** Evolution whiteout: a copy of the current frame, additively blended, with
   *  alpha driving the flash. Tint alone can only darken a texture, never push
   *  it toward white, so the flash needs its own always-white layer on top. */
  private flash: Sprite;
  private shadow: Graphics;
  private locomotion: Locomotion;
  private bobPhase = 0;
  private moving = false;
  private facing: Facing = NATIVE_FACING;
  private scale = 1;
  private tileSize: number;
  /** Extra scale multiplier on top of the base scale, for the evolution pulse.
   *  1 = normal. */
  private pulseMult = 1;

  private frontFrames!: FrameSet;
  private backFrames?: FrameSet;
  private usingBack = false;

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

    this.flash = new Sprite(Texture.EMPTY);
    this.flash.anchor.set(0.5, 1);
    this.flash.tint = 0xffffff;
    this.flash.blendMode = 'add';
    this.flash.alpha = 0;

    this.container.addChild(this.shadow, this.body, this.flash);
    this.configure(animation);
  }

  /**
   * (Re)configure for a species — used by the constructor and by evolution's
   * mid-flash sprite swap. Recomputes scale (a bigger stage reads bigger),
   * locomotion (lift/bob, and whether water crossing is allowed), and the
   * shadow, then resets to the front view.
   */
  configure(animation: PokemonAnimation): void {
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
    this.flash.alpha = 0;
    this.pulseMult = 1;
    this.body.play();
    this.applyTransform();
  }

  /** Mirror to face the direction of travel. Vertical movement keeps the
   *  previous facing — there is no back view to turn to. */
  setFacing(facing: Facing): void {
    this.facing = facing;
    this.applyTransform();
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

  /** Evolution whiteout intensity, 0 (none) to 1 (fully white). */
  setFlash(amount: number): void {
    this.flash.alpha = Math.max(0, Math.min(1, amount));
  }

  /** Extra scale multiplier for the evolution pulse; 1 clears it. */
  setPulse(mult: number): void {
    this.pulseMult = mult;
    this.applyTransform();
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
    const effective = this.scale * this.pulseMult;
    this.body.scale.x = this.facing === NATIVE_FACING ? effective : -effective;
    this.body.scale.y = effective;
    // The flash overlay always mirrors the body's current frame, transform and
    // position, so it reads as the same Pokemon lighting up rather than a
    // separate blob.
    this.flash.texture = this.body.texture;
    this.flash.y = this.body.y;
    this.flash.scale.copyFrom(this.body.scale);
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
