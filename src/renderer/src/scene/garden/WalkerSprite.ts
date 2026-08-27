import { AnimatedSprite, Container, Texture } from 'pixi.js';

// Adapted from munder-difflin (src/renderer/src/scene/office/CharacterSprite.ts),
// itself ported from shahar061/the-office (office/characters/CharacterSprite.ts).
// Difference: our sheet is the Pokemon Essentials 4x4 convention, so LEFT has its
// own row rather than being a mirrored RIGHT, and every row has 4 frames.

export type Direction = 'down' | 'left' | 'right' | 'up';
export type AnimState = 'walk' | 'idle';

/** Row order of the sheet: down=0, left=1, right=2, up=3. */
const DIRECTION_ROW: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };

export class WalkerSprite {
  readonly container: Container;
  private sprite: AnimatedSprite;
  private frames: Texture[][];
  private currentDirection: Direction = 'down';
  private currentAnim: AnimState = 'idle';

  /** `footInset` is how many transparent pixels sit below the art inside its
   *  frame; the sprite is pushed down by that much so the feet land on the tile
   *  rather than floating above it. */
  constructor(frames: Texture[][], footInset = 0) {
    this.frames = frames;
    this.container = new Container();

    this.sprite = new AnimatedSprite(this.getFrames('down', 'idle'));
    // Feet at the origin: the walker's world position is its tile's bottom edge.
    this.sprite.anchor.set(0.5, 1);
    this.sprite.y = footInset;
    this.sprite.animationSpeed = 0.12;
    this.sprite.play();

    this.container.addChild(this.sprite);
  }

  /** The walk cycle is the direction's whole row — the sheet's own column
   *  sequence, so a 2-pose side walk and a 4-pose front walk both just work. */
  private getFrames(direction: Direction, anim: AnimState): Texture[] {
    const row = this.frames[DIRECTION_ROW[direction]];
    return anim === 'idle' ? [row[0]] : row;
  }

  setAnimation(anim: AnimState, direction: Direction): void {
    if (anim === this.currentAnim && direction === this.currentDirection) return;
    this.currentAnim = anim;
    this.currentDirection = direction;
    this.sprite.textures = this.getFrames(direction, anim);
    this.sprite.animationSpeed = anim === 'walk' ? 0.14 : 0.05;
    this.sprite.play();
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
