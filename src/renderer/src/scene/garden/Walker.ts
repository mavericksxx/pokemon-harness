import { Container, Graphics, Text } from 'pixi.js';
import { WalkerSprite, type Facing } from './WalkerSprite';
import type { PokemonAnimation } from './showdownArt';
import { findPath } from './pathfinding';
import { ToolBubble } from './ToolBubble';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { SessionStatus } from '@shared/types';

/**
 * One session's avatar in the garden.
 *
 * Heavily slimmed adaptation of munder-difflin's Character.ts (which adapts
 * shahar061/the-office). Kept: the BFS-path follow loop and its tile→pixel
 * convention (feet at the tile's bottom edge, sprite anchored (0.5, 1)), the
 * wander behaviour, and the tool bubble. Dropped: seating/desk cropping, coffee
 * breaks, idle 30/30 loop, message envelopes, portrait art, status glyph zoo.
 */

const SPEED = 44; // px/sec at tileSize 16
const WANDER_MIN_DELAY = 1.5;
const WANDER_MAX_DELAY = 4.5;
const WANDER_RANGE = 5;

interface WalkerOptions {
  sessionId: string;
  map: TiledMapRenderer;
  animation: PokemonAnimation;
  /** Where the walker first appears (the garden entrance). */
  startTile: { x: number; y: number };
  /** The tile wandering orbits — the session's claimed station, so several
   *  sessions loiter in their own patches instead of all piling on the gate. */
  homeTile: { x: number; y: number };
  accentColor: number;
  label: string;
  onClick?: (sessionId: string) => void;
}

export class Walker {
  readonly sessionId: string;
  readonly container: Container;

  private map: TiledMapRenderer;
  private sprite: WalkerSprite;
  private bubble: ToolBubble;
  private badge: Graphics;
  private nameTag: Text;
  private selectionRing: Graphics;

  private px: number;
  private py: number;
  private path: { x: number; y: number }[] = [];
  private facing: Facing = 'left';
  private walking = false;
  /** Whether this species may cross water. Flying and levitating Pokemon take
   *  the short way over the pond; walkers go around it. */
  private readonly overWater: boolean;

  private wandering = true;
  private wanderTimer = 0;
  private wanderDelay = WANDER_MIN_DELAY;

  private status: SessionStatus = 'starting';
  private homeTile: { x: number; y: number };
  private badgePulse = 0;

  constructor(opts: WalkerOptions) {
    this.sessionId = opts.sessionId;
    this.map = opts.map;
    this.homeTile = { ...opts.homeTile };
    this.overWater = opts.animation.info.locomotion !== 'walk';

    const ts = this.map.tileSize;
    this.px = opts.startTile.x * ts + ts / 2;
    this.py = opts.startTile.y * ts + ts;

    this.container = new Container();
    this.container.sortableChildren = true;

    this.selectionRing = new Graphics();
    this.selectionRing.visible = false;
    this.selectionRing.ellipse(0, -2, 12, 6).stroke({ width: 1.5, color: opts.accentColor });

    // No tint: the walkers are real Pokemon sprites now, and each session is
    // told apart by its species. The accent survives on the selection ring.
    this.sprite = new WalkerSprite(opts.animation, ts);

    this.badge = new Graphics();
    this.badge.visible = false;
    // Badge art is drawn around its own origin; park that origin above the head.
    this.badge.y = -this.sprite.drawnHeight - 4;

    this.nameTag = new Text({
      text: opts.label,
      style: { fontSize: 16, fontFamily: 'monospace', fill: '#f4ffe8', align: 'center' }
    });
    this.nameTag.scale.set(0.35);
    this.nameTag.anchor.set(0.5, 0);
    this.nameTag.y = 4;

    this.bubble = new ToolBubble();

    this.container.addChild(this.selectionRing, this.sprite.container, this.badge, this.nameTag);
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';
    // Hit area follows the DRAWN sprite: a Snorlax and a Pikachu are very
    // different targets, and a fixed box would miss most of one and overreach
    // the other.
    const halfW = Math.max(8, this.sprite.drawnWidth / 2);
    const top = -Math.max(16, this.sprite.drawnHeight);
    this.container.hitArea = {
      contains: (x: number, y: number) => x > -halfW && x < halfW && y > top && y < 4
    };
    if (opts.onClick) this.container.on('pointertap', () => opts.onClick!(this.sessionId));

    this.syncPosition();
  }

  /** The bubble lives on the map's character layer, not inside the walker, so it
   *  is never occluded by another walker's sprite. */
  get bubbleContainer(): Container {
    return this.bubble.container;
  }

  get worldX(): number {
    return this.px;
  }
  get worldY(): number {
    return this.py;
  }

  get tile(): { x: number; y: number } {
    return this.map.pixelToTile(this.px, this.py - 1);
  }

  setSelected(selected: boolean): void {
    this.selectionRing.visible = selected;
  }

  setLabel(label: string): void {
    this.nameTag.text = label;
  }

  /** Walk to a tile. Wandering stops until the walker is put back into it.
   *  Returns false when the tile is unreachable, so the caller can retry on the
   *  next status change rather than believing the walker is on its way. */
  goTo(tile: { x: number; y: number }): boolean {
    const path = findPath(this.map, this.tile, tile, this.canEnter);
    if (!path) return false; // unreachable — stay put rather than teleport
    this.wandering = false;
    this.path = path;
    this.walking = path.length > 0;
    this.sprite.setMoving(this.walking);
    return true;
  }

  /** Where this Pokemon may go. Fliers add the pond to the walkable grid; they
   *  do not get a grid of their own, so the map stays the one source of truth. */
  private canEnter = (x: number, y: number): boolean =>
    this.map.isWalkable(x, y) || (this.overWater && this.map.isWater(x, y));

  /** Resume aimless strolling around the walker's home station. Any errand in
   *  flight is truncated to its current step: dropping the path outright would
   *  strand the sprite between tiles, and running it to completion would make an
   *  idle session visibly finish work it is no longer doing. */
  beginWander(): void {
    this.path = this.path.slice(0, 1);
    this.wandering = true;
    this.wanderTimer = 0;
    this.wanderDelay = WANDER_MIN_DELAY;
  }

  setStatus(status: SessionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.redrawBadge();
  }

  showTool(tool: string, target: string): void {
    this.bubble.show(tool, target);
  }

  showText(text: string): void {
    this.bubble.showText(text);
  }

  lingerBubble(): void {
    this.bubble.startLinger();
  }

  hideBubble(): void {
    this.bubble.hide();
  }

  update(dt: number): void {
    if (this.walking) this.updateWalk(dt);
    else if (this.wandering) this.updateWander(dt);
    this.sprite.update(dt);

    if (this.status === 'blocked') {
      this.badgePulse += dt;
      this.badge.alpha = 0.55 + 0.45 * Math.sin(this.badgePulse * 6);
    }

    this.bubble.update(dt);
    // Above the head, not the feet: these sprites are several tiles tall, and a
    // foot-anchored bubble would sit across the Pokemon's chest.
    this.bubble.setPosition(this.px, this.py - this.sprite.drawnHeight);
  }

  private updateWalk(dt: number): void {
    if (this.path.length === 0) {
      this.walking = false;
      this.sprite.setMoving(false);
      return;
    }

    const target = this.path[0];
    const ts = this.map.tileSize;
    // Feet at the tile's BOTTOM edge — matches the sprite's (0.5, 1) anchor.
    const targetPx = target.x * ts + ts / 2;
    const targetPy = target.y * ts + ts;
    const dx = targetPx - this.px;
    const dy = targetPy - this.py;
    const dist = Math.hypot(dx, dy);

    if (dist < 1) {
      this.px = targetPx;
      this.py = targetPy;
      this.path.shift();
      this.syncPosition();
      return;
    }

    const step = Math.min(SPEED * dt, dist);
    this.px += (dx / dist) * step;
    this.py += (dy / dist) * step;
    // Only horizontal travel changes facing: there is no back view to turn to,
    // so a walker heading straight up or down keeps the way it was already
    // pointing rather than snapping about.
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? 'right' : 'left';
      this.sprite.setFacing(this.facing);
    }
    this.sprite.setMoving(true);
    this.syncPosition();
  }

  private updateWander(dt: number): void {
    this.wanderTimer += dt;
    if (this.wanderTimer < this.wanderDelay) return;
    this.wanderTimer = 0;
    this.wanderDelay = WANDER_MIN_DELAY + Math.random() * (WANDER_MAX_DELAY - WANDER_MIN_DELAY);

    const cur = this.tile;
    for (let attempt = 0; attempt < 16; attempt++) {
      const tx = this.homeTile.x + Math.floor(Math.random() * WANDER_RANGE * 2) - WANDER_RANGE;
      const ty = this.homeTile.y + Math.floor(Math.random() * WANDER_RANGE * 2) - WANDER_RANGE;
      if ((tx === cur.x && ty === cur.y) || !this.canEnter(tx, ty)) continue;
      const path = findPath(this.map, cur, { x: tx, y: ty }, this.canEnter);
      if (!path || path.length === 0) continue;
      this.path = path;
      this.walking = true;
      this.sprite.setMoving(true);
      return;
    }
  }

  private syncPosition(): void {
    this.container.x = Math.round(this.px);
    this.container.y = Math.round(this.py);
    // Depth-sort by feet Y so a walker further down the map draws in front.
    this.container.zIndex = Math.round(this.py);
  }

  private redrawBadge(): void {
    this.badge.clear();
    this.badge.alpha = 1;
    this.badgePulse = 0;
    if (this.status === 'blocked') {
      // A pulsing "!" above the head.
      this.badge.roundRect(-3, -12, 6, 12, 2).fill(0xffd23f);
      this.badge.rect(-1, -10, 2, 6).fill(0x3a2a05);
      this.badge.rect(-1, -3, 2, 2).fill(0x3a2a05);
      this.badge.visible = true;
    } else if (this.status === 'working') {
      this.badge.circle(0, -6, 2.5).fill(0x7bd45f);
      this.badge.visible = true;
    } else if (this.status === 'done') {
      this.badge.circle(0, -6, 2.5).fill(0x8a8f88);
      this.badge.visible = true;
    } else {
      this.badge.visible = false;
    }
  }

  destroy(): void {
    this.bubble.destroy();
    this.container.destroy({ children: true });
  }
}
