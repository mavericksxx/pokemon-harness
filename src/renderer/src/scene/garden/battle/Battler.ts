import { Container } from 'pixi.js';
import { WalkerSprite, type Facing } from '../WalkerSprite';
import type { PokemonAnimation } from '../showdownArt';
import type { TiledMapRenderer } from '../TiledMapRenderer';
import type { DexEntry } from '../dexData';
import { findPath } from '../pathfinding';
import { ToolBubble, TOOL_BUBBLE_Z_BASE } from '../ToolBubble';
import { purgeBattleFxFor, spawnMoveText, spawnPokeballRecall } from './battleFx';

const SPEED = 44; // px/sec — matches Walker's SPEED so approach reads the same
const POOF_IN_MS = 260;
const POOF_OUT_MS = 220;
/** Poof-in starts at this scale and grows to 1 over POOF_IN_MS. Deliberately
 *  not near-zero: if this battler's own `update()` were ever starved for a
 *  tick or more (e.g. BattleManager.update() throwing on a DIFFERENT
 *  parent's battle before reaching this one — see BattleManager.ts's file
 *  header on the invisible-subagent bug this guards against), a frozen
 *  battler should read as visibly-stuck-small, not as having silently never
 *  appeared at all. */
const POOF_IN_START_SCALE = 0.4;

/**
 * One wild Pokemon spawned for a subagent battle (Phase 4 Part B).
 *
 * A deliberately lighter sibling of `Walker`: it reuses `WalkerSprite` (the
 * bob/lift/mirror rendering) and `findPath` (the same BFS the garden's own
 * walkers use, so "no teleporting" holds here too), but skips everything a
 * battler doesn't need — station routing, evolution, the
 * name tag/badge/selection ring. It never turns to a back view; the spec
 * only asks that of the parent.
 */
export class Battler {
  readonly container: Container;
  readonly species: DexEntry;
  /** The tile this battler is assigned to stand at during face-off/battle —
   *  set by BattleManager once it picks a properly-spaced spot, and read back
   *  by it to keep other battlers' spots from overlapping. Distinct from
   *  `tile` (this battler's ACTUAL current tile, from its live px/py) so the
   *  target survives being read before `goTo` finishes walking there. */
  standTile: { x: number; y: number } | null = null;

  private map: TiledMapRenderer;
  private sprite: WalkerSprite;
  private bubble: ToolBubble;
  private bubbleLabel?: string;
  private px: number;
  private py: number;
  private path: { x: number; y: number }[] = [];
  private moving = false;
  private facing: Facing = 'left';

  private poofPhase: 'in' | 'live' | 'out' | 'gone' = 'in';
  private poofElapsed = 0;
  /** Guards `startRecall` against being triggered twice on the same battler
   *  (a double-click on the despawn button). */
  private recalling = false;

  constructor(opts: {
    map: TiledMapRenderer;
    animation: PokemonAnimation;
    species: DexEntry;
    spawnTile: { x: number; y: number };
    label?: string;
    onClick?: () => void;
  }) {
    this.map = opts.map;
    this.species = opts.species;
    const ts = this.map.tileSize;
    this.px = opts.spawnTile.x * ts + ts / 2;
    this.py = opts.spawnTile.y * ts + ts;

    this.container = new Container();
    this.container.sortableChildren = true;
    this.sprite = new WalkerSprite(opts.animation, ts);
    this.bubble = new ToolBubble();
    this.bubbleLabel = opts.label?.trim() || undefined;
    this.container.addChild(this.sprite.container);
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';
    if (opts.onClick) this.container.on('pointertap', opts.onClick);
    this.container.scale.set(POOF_IN_START_SCALE);
    this.layoutHitArea();
    this.syncPosition();
    this.syncBubblePosition();
  }

  /** Explicit hit-test rectangle, sized off the drawn sprite exactly like
   *  Walker's own `layoutForSprite` — parity that matters for
   *  GardenScene.tsx's charLayer click resolver (the hit-test-theft fix,
   *  see its own comment): the resolver treats every walker AND battler as a
   *  candidate purely by testing `container.hitArea`, so a battler with no
   *  hitArea would never even be considered a candidate, let alone win one.
   *  This does NOT reintroduce theft on its own — Pixi's own default
   *  first-hit resolution never gets to use it, because the resolver
   *  intercepts every charLayer click during the capture phase before any
   *  individual container's own hitArea can decide a winner. Re-run from
   *  `setAnimation` too, since a lazy-loaded sprite swap can change the
   *  drawn size after spawn. */
  private layoutHitArea(): void {
    const halfW = Math.max(8, this.sprite.drawnWidth / 2);
    const top = -Math.max(16, this.sprite.drawnHeight);
    this.container.hitArea = {
      contains: (x: number, y: number) => x > -halfW && x < halfW && y > top && y < 4
    };
  }

  get worldX(): number {
    return this.px;
  }
  get worldY(): number {
    return this.py;
  }

  /** The bubble lives beside the battler on the map's character layer, just
   *  like Walker's bubble, so another Pokemon's sprite cannot occlude it. */
  get bubbleContainer(): Container {
    return this.bubble.container;
  }

  get tile(): { x: number; y: number } {
    return this.map.pixelToTile(this.px, this.py - 1);
  }

  /** Drawn height, for move-text/flash placement above the head. */
  get drawnHeight(): number {
    return this.sprite.drawnHeight;
  }

  get isSpawning(): boolean {
    return this.poofPhase === 'in';
  }

  get isPoofedOut(): boolean {
    return this.poofPhase === 'gone';
  }

  /** True once the poof-in finished and any queued path has been walked. */
  get arrived(): boolean {
    return this.poofPhase === 'live' && this.path.length === 0 && !this.moving;
  }

  /** BFS-path to a tile, ground-only (wild battlers don't need flight — every
   *  meet/fan tile is chosen walkable). Returns false if unreachable; caller
   *  falls back to standing at the spawn tile rather than teleporting. */
  goTo(tile: { x: number; y: number }): boolean {
    const path = findPath(this.map, this.tile, tile, (x, y) => this.map.isWalkable(x, y));
    if (!path) return false;
    this.path = path;
    this.moving = path.length > 0;
    this.sprite.setMoving(this.moving);
    return true;
  }

  /** Instant art swap for a species that finished a lazy fetch after this
   *  battler already spawned with a placeholder — mirrors Walker's own
   *  non-ceremony setAnimation. */
  setAnimation(animation: PokemonAnimation): void {
    this.sprite.configure(animation);
    this.layoutHitArea();
  }

  /** The floating "«Species» used «Tool»!" move text. */
  showMoveText(text: string): void {
    spawnMoveText(this.container, text, -this.sprite.drawnHeight - 4);
  }

  /** Store the Task description/subagent type for the battle bubble. The
   *  manager controls whether it is intermittently shown while roaming or
   *  pinned during the queued/battle phases. */
  setBubbleLabel(label?: string): void {
    this.bubbleLabel = label?.trim() || undefined;
  }

  showBubbleLabel(): void {
    if (this.bubbleLabel) this.bubble.showText(this.bubbleLabel);
    else this.bubble.hide();
  }

  /** Show the shared walker-style tool/icon bubble for one attack beat or
   *  live roaming-subagent tool update. */
  showAttack(tool: string, target = ''): void {
    if (tool) this.bubble.show(tool, target);
  }

  hideBubble(): void {
    this.bubble.hide();
  }

  /** Fixed battle stance: native/UNMIRRORED front sheet. No direction math —
   *  gen5ani front art is drawn already facing down-left, and every battler
   *  is placed in the top/right arc from the parent (see BattleManager's
   *  pickChallengerStandTile), so unmirrored already points at it. Called
   *  once face-off begins and every tick through the attack loop
   *  (idempotent), overriding whatever the approach walk's own
   *  movement-direction mirroring left it at. */
  setBattleStance(): void {
    this.facing = 'left';
    this.sprite.setFacing('left');
  }

  /** Begin the poof-out shrink; `isPoofedOut` goes true once it completes. */
  startPoofOut(): void {
    if (this.poofPhase === 'out' || this.poofPhase === 'gone') return;
    this.poofPhase = 'out';
    this.poofElapsed = 0;
  }

  /** Pokéball recall — the despawn action's own animation (done/retired
   *  battlers only, see BattleManager.ts's `despawnBattler`), distinct from
   *  `startPoofOut`'s plain uniform shrink (used for `handleEndAll`'s coarse
   *  cleanup). Passes `this.sprite.container` (not `this.container`) as the
   *  thing that actually shrinks, so `spawnPokeballRecall`'s ball — added as
   *  a sibling under `this.container` — can hold its own size throughout
   *  instead of shrinking away along with the sprite. `onDone` fires once,
   *  when the whole sequence completes (or after one flash frame under
   *  prefers-reduced-motion); the caller destroys this battler only then,
   *  not on any `poofPhase`/`isPoofedOut` state — this animation runs on its
   *  own clock. */
  startRecall(onDone: () => void): void {
    if (this.recalling) return;
    this.recalling = true;
    spawnPokeballRecall(this.container, this.sprite.container, this.drawnHeight, onDone);
  }

  update(dt: number): void {
    if (this.poofPhase === 'in') {
      this.poofElapsed += dt * 1000;
      const t = Math.min(1, this.poofElapsed / POOF_IN_MS);
      this.container.scale.set(POOF_IN_START_SCALE + (1 - POOF_IN_START_SCALE) * t);
      if (t >= 1) this.poofPhase = 'live';
    } else if (this.poofPhase === 'out') {
      this.poofElapsed += dt * 1000;
      const t = Math.min(1, this.poofElapsed / POOF_OUT_MS);
      this.container.scale.set(Math.max(0.001, 1 - t));
      if (t >= 1) this.poofPhase = 'gone';
    }

    if (this.path.length > 0) this.updateWalk(dt);
    this.sprite.update(dt);
    this.syncPosition();
    this.bubble.update(dt);
    this.syncBubblePosition();
  }

  private updateWalk(dt: number): void {
    const target = this.path[0];
    const ts = this.map.tileSize;
    const targetPx = target.x * ts + ts / 2;
    const targetPy = target.y * ts + ts;
    const dx = targetPx - this.px;
    const dy = targetPy - this.py;
    const dist = Math.hypot(dx, dy);

    if (dist < 1) {
      this.px = targetPx;
      this.py = targetPy;
      this.path.shift();
      if (this.path.length === 0) {
        this.moving = false;
        this.sprite.setMoving(false);
      }
      return;
    }

    const step = Math.min(SPEED * dt, dist);
    this.px += (dx / dist) * step;
    this.py += (dy / dist) * step;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? 'right' : 'left';
      this.sprite.setFacing(this.facing);
    }
  }

  private syncPosition(): void {
    this.container.x = Math.round(this.px);
    this.container.y = Math.round(this.py);
    this.container.zIndex = Math.round(this.py);
  }

  /** Keep the sibling bubble over the sprite's head. BattleManager calls this
   *  once more after applying a lunge, since the lunge temporarily offsets the
   *  Pixi container without changing the battler's logical world position. */
  syncBubblePosition(): void {
    this.bubble.setPosition(this.container.x, this.container.y - this.sprite.drawnHeight);
    // Same overlay-tier Y-sort as Walker's own bubble — see that file's
    // comment on this line for the full reasoning.
    this.bubble.container.zIndex = TOOL_BUBBLE_Z_BASE + Math.round(this.py);
  }

  destroy(): void {
    // 2026-08-29 production crash fix (see battleFx.ts's `tickBattleFx` doc
    // comment for the full root cause): a still-animating FX (e.g. this
    // battler's own "used Task!" move text, which runs up to 1.4s) is a
    // CHILD of `this.container` — purge it BEFORE destroying that container,
    // so its own tick can never run again against an object Pixi has already
    // nulled out.
    purgeBattleFxFor(this.container);
    if (this.bubble.container.parent) this.bubble.container.parent.removeChild(this.bubble.container);
    this.bubble.destroy();
    this.sprite.destroy();
    this.container.destroy({ children: true });
  }
}
