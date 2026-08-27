import { Container, Graphics, Text, Texture } from 'pixi.js';
import { WalkerSprite, type Direction } from './WalkerSprite';
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
  frames: Texture[][];
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
  private direction: Direction = 'down';
  private walking = false;

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

    const ts = this.map.tileSize;
    this.px = opts.startTile.x * ts + ts / 2;
    this.py = opts.startTile.y * ts + ts;

    this.container = new Container();
    this.container.sortableChildren = true;

    this.selectionRing = new Graphics();
    this.selectionRing.visible = false;
    this.selectionRing.ellipse(0, -2, 12, 6).stroke({ width: 1.5, color: opts.accentColor });

    this.sprite = new WalkerSprite(opts.frames);
    // Tint the generated sheet toward this session's accent so multiple walkers
    // are distinguishable even with one placeholder sprite.
    this.sprite.container.tint = opts.accentColor;

    this.badge = new Graphics();
    this.badge.visible = false;

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
    this.container.hitArea = { contains: (x: number, y: number) => x > -12 && x < 12 && y > -32 && y < 4 };
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
    const path = findPath(this.map, this.tile, tile);
    if (!path) return false; // unreachable — stay put rather than teleport
    this.wandering = false;
    this.path = path;
    this.walking = path.length > 0;
    if (this.walking) this.sprite.setAnimation('walk', this.direction);
    return true;
  }

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

    if (this.status === 'blocked') {
      this.badgePulse += dt;
      this.badge.alpha = 0.55 + 0.45 * Math.sin(this.badgePulse * 6);
    }

    this.bubble.update(dt);
    this.bubble.setPosition(this.px, this.py);
  }

  private updateWalk(dt: number): void {
    if (this.path.length === 0) {
      this.walking = false;
      this.sprite.setAnimation('idle', this.direction);
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
    this.direction =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    this.sprite.setAnimation('walk', this.direction);
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
      if ((tx === cur.x && ty === cur.y) || !this.map.isWalkable(tx, ty)) continue;
      const path = findPath(this.map, cur, { x: tx, y: ty });
      if (!path || path.length === 0) continue;
      this.path = path;
      this.walking = true;
      this.sprite.setAnimation('walk', this.direction);
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
      this.badge.roundRect(-3, -46, 6, 12, 2).fill(0xffd23f);
      this.badge.rect(-1, -44, 2, 6).fill(0x3a2a05);
      this.badge.rect(-1, -37, 2, 2).fill(0x3a2a05);
      this.badge.visible = true;
    } else if (this.status === 'working') {
      this.badge.circle(0, -40, 2.5).fill(0x7bd45f);
      this.badge.visible = true;
    } else if (this.status === 'done') {
      this.badge.circle(0, -40, 2.5).fill(0x8a8f88);
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
