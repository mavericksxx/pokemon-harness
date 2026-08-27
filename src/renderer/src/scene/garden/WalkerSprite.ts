import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { Locomotion, PokemonAnimation } from './showdownArt';
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
  private readonly scale: number;

  constructor(animation: PokemonAnimation, tileSize: number) {
    this.locomotion = animation.info.locomotion;
    this.container = new Container();
    // Battle sprites are far too big for a 16px grid; normalise toward a target
    // height in tiles that keeps the species' relative sizes. See spriteScale.ts.
    this.scale = spriteScale(animation.info.name, animation.info.frameHeight, tileSize);

    // The shadow stays on the ground while the body bobs and lifts above it,
    // which is what sells the float. Three stacked ellipses in place of a blur:
    // a filter would mean compiling a shader, and the renderer forbids eval.
    this.shadow = new Graphics();
    // Sized off the DRAWN width, so it tracks the sprite rather than the sheet.
    const rx = animation.info.frameWidth * this.scale * 0.3;
    const ry = rx * 0.38;
    for (const [scale, alpha] of [
      [1.25, 0.06],
      [1.1, 0.1],
      [1, 0.22]
    ]) {
      this.shadow.ellipse(0, -ry * 0.5, rx * scale, ry * scale).fill({ color: 0x000000, alpha });
    }

    this.body = new AnimatedSprite(animation.frames);
    // Feet at the origin: the walker's world position is its tile's bottom edge.
    // The sprite is far taller than a tile, so it overlaps the tiles above it —
    // which is exactly what the map's `furniture-above` canopies draw over.
    this.body.anchor.set(0.5, 1);
    // FrameObject `time` values are milliseconds at speed 1.
    this.body.animationSpeed = 1;
    this.body.scale.set(this.scale);
    this.body.play();

    this.container.addChild(this.shadow, this.body);
    this.applyTransform();
  }

  /** Mirror to face the direction of travel. Vertical movement keeps the
   *  previous facing — there is no back view to turn to. */
  setFacing(facing: Facing): void {
    this.facing = facing;
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
    this.body.scale.x = this.facing === NATIVE_FACING ? this.scale : -this.scale;
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
