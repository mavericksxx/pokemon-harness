import { Container, Graphics, Text } from 'pixi.js';
import { WalkerSprite, type Facing } from './WalkerSprite';
import type { Locomotion, PokemonAnimation } from './showdownArt';
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

/** Consecutive up-moving tiles before the back sheet kicks in, and consecutive
 *  non-up tiles before it drops back to front — two different thresholds so a
 *  path that zigzags between up and sideways segments doesn't flip every tile. */
const BACK_VIEW_ON = 2;
const BACK_VIEW_OFF = -1;
const BACK_VIEW_BIAS_MAX = 3;

/** Evolution flash + pulse + sparkle duration, seconds. */
const EVOLVE_DURATION = 2;
/** Scale-oscillation cycles over that duration (spec: 2-3). */
const EVOLVE_PULSES = 3;
/** Fraction of the way through the effect when the sprite actually swaps —
 *  timed to land while the flash is near its brightest, so the swap is hidden
 *  in the whiteout rather than visible mid-animation. */
const EVOLVE_SWAP_AT = 0.55;

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

interface EvolutionFx {
  animation: PokemonAnimation;
  toLabel: string;
  fromLabel: string;
  elapsed: number;
  swapped: boolean;
  sparkleTimer: number;
  /** Fired the instant the sprite swaps (hidden in the flash), so the caller
   *  can update the session store's `pokemon` field in step with what's on
   *  screen rather than at evolve() call time, ~1s earlier. */
  onSwap?: () => void;
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
  private sparkleLayer: Container;
  private floatLayer: Container;

  private px: number;
  private py: number;
  private path: { x: number; y: number }[] = [];
  private facing: Facing = 'left';
  private walking = false;
  /** How this species gets around. Mutable: evolving can add flight
   *  (Charizard) or drop levitation (Gastly's line tops out walking, as
   *  Gengar). */
  private locomotion: Locomotion;

  private wandering = true;
  private wanderTimer = 0;
  private wanderDelay = WANDER_MIN_DELAY;

  /** Which target the current up/down/left/right bias vote was computed for,
   *  so it only fires once per path segment rather than every frame. */
  private facingTarget: { x: number; y: number } | null = null;
  private backViewBias = 0;

  private status: SessionStatus = 'starting';
  private homeTile: { x: number; y: number };
  private badgePulse = 0;
  private accentColor: number;

  private evolutionFx: EvolutionFx | null = null;

  constructor(opts: WalkerOptions) {
    this.sessionId = opts.sessionId;
    this.map = opts.map;
    this.homeTile = { ...opts.homeTile };
    this.locomotion = opts.animation.info.locomotion;

    const ts = this.map.tileSize;
    this.px = opts.startTile.x * ts + ts / 2;
    this.py = opts.startTile.y * ts + ts;

    this.container = new Container();
    this.container.sortableChildren = true;

    // No tint: the walkers are real Pokemon sprites now, and each session is
    // told apart by its species. The accent survives on the selection ring.
    this.sprite = new WalkerSprite(opts.animation, ts);

    this.selectionRing = new Graphics();
    this.selectionRing.visible = false;

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
    this.sparkleLayer = new Container();
    this.floatLayer = new Container();

    this.container.addChild(
      this.selectionRing,
      this.sprite.container,
      this.badge,
      this.nameTag,
      this.sparkleLayer,
      this.floatLayer
    );
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';
    this.accentColor = opts.accentColor;
    this.layoutForSprite();
    if (opts.onClick) this.container.on('pointertap', () => opts.onClick!(this.sessionId));

    this.syncPosition();
  }

  /** Ring/badge/hit-area geometry follows the DRAWN sprite. Re-run after
   *  evolving, since a bigger stage needs a bigger ring and hit area. */
  private layoutForSprite(): void {
    const ringX = Math.max(9, this.sprite.drawnWidth * 0.42);
    this.selectionRing.clear();
    this.selectionRing.ellipse(0, -2, ringX, ringX * 0.42).stroke({ width: 1.5, color: this.accentColor });

    // Badge art is drawn around its own origin; park that origin above the head.
    this.badge.y = -this.sprite.drawnHeight - 4;

    const halfW = Math.max(8, this.sprite.drawnWidth / 2);
    const top = -Math.max(16, this.sprite.drawnHeight);
    this.container.hitArea = {
      contains: (x: number, y: number) => x > -halfW && x < halfW && y > top && y < 4
    };
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

  /** Whether this species may cross water right now — checked live so an
   *  evolve into (or out of) flight takes effect immediately. */
  get canFly(): boolean {
    return this.locomotion !== 'walk';
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
    this.map.isWalkable(x, y) || (this.canFly && this.map.isWater(x, y));

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

  /** Kick off the evolution animation; the actual sprite swap happens partway
   *  through it (see EVOLVE_SWAP_AT), hidden inside the white flash. A second
   *  call while one is already running is ignored — thresholds are crossed in
   *  order, so evolve() is called once per stage. */
  evolve(nextAnimation: PokemonAnimation, fromLabel: string, toLabel: string, onSwap?: () => void): void {
    if (this.evolutionFx) return;
    this.evolutionFx = {
      animation: nextAnimation,
      fromLabel,
      toLabel,
      elapsed: 0,
      swapped: false,
      sparkleTimer: 0,
      onSwap
    };
  }

  get isEvolving(): boolean {
    return this.evolutionFx !== null;
  }

  /** Instant, no-flash art swap — used when a lazily-fetched species' real
   *  sprite finishes loading after the walker already spawned with a
   *  pokeball placeholder. (Evolution's own swap goes through the flash
   *  sequence instead; see evolve().) */
  setAnimation(animation: PokemonAnimation): void {
    this.sprite.configure(animation);
    this.locomotion = animation.info.locomotion;
    this.layoutForSprite();
    // configure() resets the sprite to its front view; match that here so a
    // walker that evolves mid-upward-walk doesn't show front while its bias
    // counter (still primed from before) silently disagrees.
    this.backViewBias = 0;
    this.facingTarget = null;
  }

  update(dt: number): void {
    if (this.walking) this.updateWalk(dt);
    else if (this.wandering) this.updateWander(dt);
    this.sprite.update(dt);
    if (this.evolutionFx) this.updateEvolution(dt);
    this.updateFloatingText(dt);

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
    if (target !== this.facingTarget) {
      this.facingTarget = target;
      this.noteSegmentDirection(target);
    }

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
      this.facingTarget = null;
      this.syncPosition();
      return;
    }

    const step = Math.min(SPEED * dt, dist);
    this.px += (dx / dist) * step;
    this.py += (dy / dist) * step;
    // Only horizontal travel changes left/right facing: there is no side view
    // to turn to, so a walker heading straight up or down keeps the way it was
    // already pointing (the back sheet, when in use, mirrors the same way).
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? 'right' : 'left';
      this.sprite.setFacing(this.facing);
    }
    this.sprite.setMoving(true);
    this.syncPosition();
  }

  /** BFS paths move one cardinal tile at a time, so every segment is purely
   *  horizontal or purely vertical — no diagonals to average. Vote on this
   *  segment's direction with hysteresis so a path that zigzags between an "up"
   *  tile and a sideways tile doesn't flip the sheet every step. */
  private noteSegmentDirection(target: { x: number; y: number }): void {
    const cur = this.tile;
    const goingUp = target.y < cur.y && target.x === cur.x;
    this.backViewBias = goingUp
      ? Math.min(this.backViewBias + 1, BACK_VIEW_BIAS_MAX)
      : Math.max(this.backViewBias - 1, -BACK_VIEW_BIAS_MAX);
    if (this.backViewBias >= BACK_VIEW_ON) this.sprite.setBackView(true);
    else if (this.backViewBias <= BACK_VIEW_OFF) this.sprite.setBackView(false);
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

  private updateEvolution(dt: number): void {
    const fx = this.evolutionFx;
    if (!fx) return;
    fx.elapsed += dt;
    const t = Math.min(fx.elapsed / EVOLVE_DURATION, 1);

    // Scale pulses the whole time; the flash rises fast, holds near white
    // through the swap, then fades out over the last third.
    this.sprite.setPulse(1 + 0.16 * Math.sin(t * EVOLVE_PULSES * Math.PI * 2));
    const flashIn = Math.min(fx.elapsed / 0.2, 1);
    const flashOut = t > 0.65 ? Math.max(0, 1 - (t - 0.65) / 0.35) : 1;
    this.sprite.setFlash(Math.min(flashIn, flashOut));

    fx.sparkleTimer += dt;
    if (fx.sparkleTimer > 0.12 && t < 0.9) {
      fx.sparkleTimer = 0;
      this.spawnSparkle();
    }
    this.updateSparkles(dt);

    if (!fx.swapped && t >= EVOLVE_SWAP_AT) {
      fx.swapped = true;
      this.setAnimation(fx.animation);
      fx.onSwap?.();
    }

    if (t >= 1) {
      this.sprite.setFlash(0);
      this.sprite.setPulse(1);
      this.evolutionFx = null;
      this.spawnFloatingText(`${fx.fromLabel} evolved into ${fx.toLabel}!`);
    }
  }

  private spawnSparkle(): void {
    const g = new Graphics();
    const angle = Math.random() * Math.PI * 2;
    const dist = this.sprite.drawnWidth * (0.25 + Math.random() * 0.35);
    g.x = Math.cos(angle) * dist;
    g.y = -this.sprite.drawnHeight * (0.3 + Math.random() * 0.6) + Math.sin(angle) * dist * 0.3;
    g.star(0, 0, 4, 2.5, 1).fill({ color: 0xfff6c8, alpha: 0.9 });
    (g as Graphics & { life: number }).life = 0;
    this.sparkleLayer.addChild(g);
  }

  private updateSparkles(dt: number): void {
    for (const child of [...this.sparkleLayer.children]) {
      const g = child as Graphics & { life: number };
      g.life += dt;
      const t = g.life / 0.6;
      if (t >= 1) {
        this.sparkleLayer.removeChild(g);
        g.destroy();
        continue;
      }
      g.y -= dt * 14;
      g.alpha = 1 - t;
      g.scale.set(1 + t * 0.6);
    }
  }

  private spawnFloatingText(text: string): void {
    const t = new Text({
      text,
      style: {
        fontSize: 16,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fill: '#fff6c8',
        stroke: { color: 0x1b1b1b, width: 3 },
        align: 'center'
      }
    });
    t.scale.set(0.4);
    t.anchor.set(0.5, 1);
    t.y = -this.sprite.drawnHeight - 6;
    (t as Text & { life: number }).life = 0;
    this.floatLayer.addChild(t);
  }

  private updateFloatingText(dt: number): void {
    const FLOAT_DURATION = 1.8;
    for (const child of [...this.floatLayer.children]) {
      const t = child as Text & { life: number };
      t.life += dt;
      const p = t.life / FLOAT_DURATION;
      if (p >= 1) {
        this.floatLayer.removeChild(t);
        t.destroy();
        continue;
      }
      t.y -= dt * 10;
      t.alpha = p < 0.15 ? p / 0.15 : Math.min(1, (1 - p) / 0.25);
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
