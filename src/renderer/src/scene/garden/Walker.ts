import { Container, Graphics, Text } from 'pixi.js';
import { WalkerSprite, type Facing } from './WalkerSprite';
import type { Locomotion, PokemonAnimation } from './showdownArt';
import { findPath } from './pathfinding';
import { ToolBubble } from './ToolBubble';
import { EvolutionCeremony } from './EvolutionCeremony';
import { evolutionConfig } from './evolution';
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
  /** Shared scene layers the evolution ceremony renders into — see
   *  GardenScene.tsx. All three sit above the character layer, in order
   *  (dim, flash, ceremony), so a ceremony's dim overlay covers every OTHER
   *  walker, its flash-out is never crushed by another ceremony's dim, and
   *  the evolving walker itself (reparented into `ceremonyLayer` for the
   *  ceremony's duration) stays visible above both. */
  dimLayer: Container;
  flashLayer: Container;
  ceremonyLayer: Container;
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
  private floatLayer: Container;
  private dimLayer: Container;
  private flashLayer: Container;
  private ceremonyLayer: Container;

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

  private ceremony: EvolutionCeremony | null = null;
  /** Saved badge/ring visibility while the ceremony hides all UI chrome
   *  (everything but the sprite itself and its floating text) — restored
   *  verbatim on teardown rather than forced true, since either could have
   *  been legitimately hidden already. */
  private chromeWasVisible: [badge: boolean, ring: boolean] | null = null;

  constructor(opts: WalkerOptions) {
    this.sessionId = opts.sessionId;
    this.map = opts.map;
    this.homeTile = { ...opts.homeTile };
    this.locomotion = opts.animation.info.locomotion;
    this.dimLayer = opts.dimLayer;
    this.flashLayer = opts.flashLayer;
    this.ceremonyLayer = opts.ceremonyLayer;

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
    this.floatLayer = new Container();

    this.container.addChild(this.selectionRing, this.sprite.container, this.badge, this.nameTag, this.floatLayer);
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

  /** Drawn sprite height, for placing battle UI (the "+N" overflow badge)
   *  above the head without hardcoding a per-species offset. */
  get spriteHeight(): number {
    return this.sprite.drawnHeight;
  }

  /** Whether this species may cross water right now — checked live so an
   *  evolve into (or out of) flight takes effect immediately. */
  get canFly(): boolean {
    return this.locomotion !== 'walk';
  }

  setSelected(selected: boolean): void {
    // Ceremony in progress: don't let a live selection change leak the ring
    // back into view — update the saved state setChromeHidden(false) will
    // restore instead of the live (forced-hidden) flag.
    if (this.chromeWasVisible) {
      this.chromeWasVisible[1] = selected;
      return;
    }
    this.selectionRing.visible = selected;
  }

  setLabel(label: string): void {
    this.nameTag.text = label;
  }

  /** Walk to a tile. Wandering stops until the walker is put back into it.
   *  Returns false when the tile is unreachable, so the caller can retry on the
   *  next status change rather than believing the walker is on its way.
   *  Also returns false — same "retry later" contract — while an evolution
   *  ceremony is running: the walker is exclusive/uninterruptible for its
   *  duration, and GardenScene's reconcile already retries a failed goTo on
   *  the next status change. */
  goTo(tile: { x: number; y: number }): boolean {
    if (this.ceremony) return false;
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
    if (this.ceremony) return;
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

  /** Public wrapper for the evolution flavor-text mechanism — reused by the
   *  subagent battle system (Phase 4 Part B) for its "«Species» used
   *  «Tool»!" move text. */
  showFloatingText(text: string): void {
    this.spawnFloatingText(text);
  }

  /** Force the back sheet on/off regardless of the walk-direction hysteresis
   *  — used by the battle system to put the parent in its "facing away from
   *  camera, toward the opponent" battle stance (falls back to the front
   *  sheet automatically when the species has no back view; see
   *  WalkerSprite.setBackView). A no-op while an evolution ceremony is
   *  running, which already owns the sprite's view for its duration. */
  setForcedBackView(useBack: boolean): void {
    if (this.ceremony) return;
    this.sprite.setBackView(useBack);
  }

  /** Force left/right mirroring without moving — used by the battle system so
   *  the parent visually faces its opponent regardless of which way it last
   *  walked. A no-op during an evolution ceremony, which owns the sprite's
   *  transform for its duration. */
  faceDirection(facing: Facing): void {
    if (this.ceremony) return;
    this.facing = facing;
    this.sprite.setFacing(facing);
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

  /** Kick off the evolution ceremony — exclusive/uninterruptible: the walker
   *  is halted and gated (see goTo/beginWander) until it runs to completion.
   *  The actual sprite swap happens partway through it (see
   *  EvolutionCeremony's decay phase), hidden inside the white flash-out. A
   *  second call while one is already running is ignored — thresholds are
   *  crossed in order, so evolve() is called once per stage. */
  evolve(
    nextAnimation: PokemonAnimation,
    fromLabel: string,
    toLabel: string,
    toId: string,
    onSwap?: () => void
  ): void {
    if (this.ceremony) return;
    const ts = this.map.tileSize;
    this.ceremony = new EvolutionCeremony({
      container: this.container,
      sprite: this.sprite,
      newAnimation: nextAnimation,
      toId,
      tileSize: ts,
      dimLayer: this.dimLayer,
      flashLayer: this.flashLayer,
      ceremonyLayer: this.ceremonyLayer,
      mapWidthPx: this.map.width * ts,
      mapHeightPx: this.map.height * ts,
      durationScale: evolutionConfig().durationScale,
      spriteWidth: this.sprite.drawnWidth,
      spriteHeight: this.sprite.drawnHeight,
      fromLabel,
      toLabel,
      spawnText: (text) => this.spawnFloatingText(text),
      setChromeHidden: (hidden) => this.setChromeHidden(hidden),
      applySwap: () => {
        this.setAnimation(nextAnimation);
        onSwap?.();
      }
    });
  }

  get isEvolving(): boolean {
    return this.ceremony !== null;
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
    if (this.ceremony) {
      this.ceremony.update(dt);
      if (this.ceremony.done) this.ceremony = null;
    } else {
      if (this.walking) this.updateWalk(dt);
      else if (this.wandering) this.updateWander(dt);
      this.sprite.update(dt);
    }
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

  /** Hide/restore the name tag, status badge and selection ring — the
   *  ceremony's overlay is meant to show nothing but the Pokemon and its
   *  floating text (floatLayer stays untouched), same as the games. */
  private setChromeHidden(hidden: boolean): void {
    if (hidden) {
      this.chromeWasVisible = [this.badge.visible, this.selectionRing.visible];
      this.badge.visible = false;
      this.selectionRing.visible = false;
      this.nameTag.visible = false;
    } else if (this.chromeWasVisible) {
      [this.badge.visible, this.selectionRing.visible] = this.chromeWasVisible;
      this.nameTag.visible = true;
      this.chromeWasVisible = null;
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
    // Ceremony in progress: a status change mid-ceremony (working -> idle and
    // back is routine over ~9s) must not leak the badge back into view — bank
    // the value it WOULD have and force it hidden; setChromeHidden(false)
    // restores from this saved state rather than what's live at that point.
    if (this.chromeWasVisible) {
      this.chromeWasVisible[0] = this.badge.visible;
      this.badge.visible = false;
    }
  }

  destroy(): void {
    // A ceremony in flight owns overlay graphics living in the SHARED
    // overlayLayer, outside this walker's own container — dispose it first so
    // that overlay doesn't outlive the walker it was dimming the garden for.
    this.ceremony?.dispose();
    this.ceremony = null;
    this.bubble.destroy();
    this.container.destroy({ children: true });
  }
}
