import { Container, Graphics, Text } from 'pixi.js';
import { WalkerSprite, type Facing } from './WalkerSprite';
import type { Locomotion, PokemonAnimation } from './showdownArt';
import { findPath } from './pathfinding';
import { ToolBubble, TOOL_BUBBLE_Z_BASE } from './ToolBubble';
import { EvolutionCeremony } from './EvolutionCeremony';
import { MegaCeremony } from './battle/MegaCeremony';
import { purgeBattleFxFor, prefersReducedMotion, spawnPokeballRecall } from './battle/battleFx';
import { evolutionConfig } from './evolution';
import { markDirty } from './renderDirty';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { SessionStatus } from '@shared/types';
import { pinAnimation, unpinAnimation } from './lazySprites';
import { MIN_SEPARATION_TILES, type WanderReservations } from './wanderReservations';

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

/** Idle-class roam (non-working: idle/starting/blocked/done) reads calmer
 *  than a working walker's brisk free-roam — a fraction of the same SPEED
 *  rather than a second hardcoded speed, so a future SPEED retune doesn't
 *  need a second edit. */
const IDLE_SPEED_FACTOR = 0.6;
/** Idle-class walkers linger longer between legs than a working walker's
 *  WANDER_MIN/MAX_DELAY — "pausing now and then", not a business errand. */
const IDLE_WANDER_MIN_DELAY = 3;
const IDLE_WANDER_MAX_DELAY = 7;
/** Bounded attempts per idle wander-leg decision to find a destination that
 *  clears MIN_SEPARATION_TILES from every other walker's anchor. Small on
 *  purpose: only the FIRST attempt that clears the separation bar costs a
 *  real pathfind (see updateWander below), so this bounds worst case (every
 *  candidate rejected on separation, or reachable-but-nothing-clears-the-
 *  bar) rather than the common case. */
const IDLE_WANDER_ATTEMPTS = 24;

interface WalkerOptions {
  sessionId: string;
  map: TiledMapRenderer;
  animation: PokemonAnimation;
  /** Where the walker first appears (the garden entrance). */
  startTile: { x: number; y: number };
  /** This generation's shared wander-anchor tracker (see
   *  wanderReservations.ts) — every walker registers/updates its own anchor
   *  here as it moves, and an idle-class walker consults it when picking a
   *  new destination so idle walkers spread out across the garden instead
   *  of converging. */
  reservations: WanderReservations;
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
  private reservations: WanderReservations;
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

  /** Whether `update()` should be running `updateWander()` right now, for
   *  EITHER a working walker's brisk free-roam or a non-working walker's
   *  relaxed amble (see `updateWander`'s own branch on `status`) — both are
   *  driven by this one flag/timer pair now, not gated by `status` itself.
   *  Defaults true so a freshly-constructed walker starts ambling on its
   *  very first frame rather than needing an explicit kickoff call. Cleared
   *  by `goTo()`/`stayPut()` (something else has claimed this walker's
   *  path) and set by `beginWander()`. */
  private wandering = true;
  private wanderTimer = 0;
  private wanderDelay = WANDER_MIN_DELAY;

  /** True while something OTHER than this walker's own wander loop owns its
   *  position — a battle, a delegate challenge, a berry errand, or the
   *  pokéball recall (GardenScene.tsx's `positionOwnedElsewhere`). Sets via
   *  `setBusy()`, which halts any in-flight wander leg the moment it goes
   *  true and simply stops `beginWander()` from resuming until it's cleared
   *  again — the owning system (BattleManager/WalkerChallenger/GardenCharm)
   *  calls `goTo()`/`beginWander()` directly at its own pace either way, so
   *  this only needs to keep this walker's OWN autonomous loop out of its
   *  way, not choreograph anything itself. */
  private busy = false;
  /** True while this walker's session is in the active workspace — set via
   *  `setTracked()`. While false, this walker still updates every frame
   *  (Phase 8.7: work/wander continues off-stage) but stops
   *  reading/writing `reservations`, so an invisible walker in another
   *  workspace can't make an on-stage idle walker avoid a spot nobody can
   *  actually see it standing on, or vice versa. */
  private tracked = true;

  private status: SessionStatus = 'starting';
  private badgePulse = 0;
  private accentColor: number;

  /** How often the 'blocked' badge pulse and the napping "z z z" float (both
   *  below, in update()) actually mark the scene dirty, in ticker frames —
   *  every frame still advances badgePulse/zzzT underneath, so the pulse/
   *  float animation itself never stutters; only the render REQUEST is
   *  throttled, down to roughly the same "handful of frames/sec" idle rate
   *  WalkerSprite's STILL_BOB_DIRTY_EVERY_N_FRAMES already uses for the
   *  levitate/fly idle bob (see WalkerSprite.ts, issue #33). Both states can
   *  persist indefinitely (a walker can sit 'blocked' or napping for the
   *  whole session), so left unthrottled either one alone pins the whole
   *  garden-wide dirty flag at full tick rate forever, same failure shape as
   *  #33's bob. */
  private static readonly IDLE_ANIM_DIRTY_EVERY_N_FRAMES = 6;
  private blockedBadgeFrame = 0;
  private nappingZzzFrame = 0;

  /** Party-screen-style select hop (Phase 8 §4) — seconds into the hop, or
   *  null when idle. Offsets the sprite's own sub-container (never otherwise
   *  repositioned — see WalkerSprite; Walker's own `container` is what
   *  tracks px/py every tick) so it layers on top of the normal walk bob
   *  instead of fighting it. */
  private bounceT: number | null = null;
  private static readonly BOUNCE_DURATION = 0.32;
  private static readonly BOUNCE_HEIGHT = 6;

  /** Napping (Phase 8.5 Wave B items 3/4) — a plain-shell session quiet 30s+,
   *  or a claude session between a PreCompact hook and its post-compact
   *  SessionStart. Parks the walker while its idle animation keeps looping; a
   *  "z z z" overlay (`this.zzz`) shows while true. */
  private napping = false;
  private zzz: Text;
  private zzzT = 0;

  /** Mega evolution during battles (BattleManager's setTemporaryForm /
   *  startMegaCeremony calls only) — the animation to restore to on revert,
   *  or null while no temporary form is showing.
   *
   *  INVARIANT (this is what makes a mid-ceremony abort clean): this is
   *  written ONLY by the step that actually puts the mega sprite on screen —
   *  `setTemporaryForm`'s instant/reduced-motion path, or the ceremony's own
   *  flash-peak swap (`applyMegaCeremonySwap`) — never at the moment a mega is
   *  merely REQUESTED. It used to be set at request time, which meant a battle
   *  ending mid-buildup found it truthy and dutifully "reverted" a form that
   *  had never been applied — flushing the pending swap on the way out, i.e.
   *  applying-then-reverting. Harmless at the old 500ms flash, very visible at
   *  a multi-second ceremony. BattleManager's own `megaActive` flag is what
   *  answers "is a mega in flight for this wave" now; this answers only "is a
   *  temporary form currently on screen". */
  private tempFormBase: PokemonAnimation | null = null;

  /** The animation currently protected from lazySprites.ts's cache eviction
   *  (see pinAnimation/unpinAnimation there) because it's this walker's LIVE
   *  sprite right now. Kept in lockstep with whatever `this.sprite` actually
   *  shows — every place that swaps the sprite's species goes through
   *  `swapPinnedLive` so the pin transfers atomically instead of leaving a
   *  gap where the incoming or outgoing species is briefly unprotected. */
  private pinnedLive: PokemonAnimation;
  /** Set for the full ~15s of an evolution ceremony's buildup (evolve(),
   *  below) — the target species is shown via silhouette well before
   *  `setAnimation` (the ceremony's own reveal) ever runs, so it must be
   *  pinned from the moment the ceremony starts, not just once it goes live.
   *  Cleared (and its pin released) either by `setAnimation` transferring it
   *  to `pinnedLive`, or by `destroy()` if the ceremony is aborted first. */
  private pinnedEvolveTarget: PokemonAnimation | null = null;
  /** Same idea as `pinnedEvolveTarget`, for a staged mega ceremony's target
   *  (startMegaCeremony, below) — its silhouette shows the mega form for the
   *  whole buildup before `applyMegaCeremonySwap` ever runs. Cleared there,
   *  or by `cancelMegaCeremony` if the ceremony is aborted first. */
  private pinnedMegaTarget: PokemonAnimation | null = null;
  /** Elapsed ms into the current mega flash beat, or null when idle — see
   *  flashSwap(). */
  private megaFlashT: number | null = null;
  private megaFlashSwap: (() => void) | null = null;
  /** Lives in the SHARED flashLayer (not this walker's own container, which
   *  battle stance and evolution both reparent/hide pieces of) — cleaned up
   *  explicitly wherever it could otherwise outlive what it's flashing over
   *  (cancelMegaFlash, destroy()). */
  private megaFlashGraphic: Graphics | null = null;
  private static readonly MEGA_FLASH_MS = 500;

  /** The staged mega-evolution ceremony (battle-only), or null when none is
   *  running — see battle/MegaCeremony.ts. Distinct from `ceremony` below:
   *  that one is real evolution's, owns the sprite exclusively, and reparents
   *  the walker; this one only decorates it in place while a battle wave is
   *  held. Only ever one at a time per walker. */
  private megaCeremony: MegaCeremony | null = null;

  private ceremony: EvolutionCeremony | null = null;
  /** Saved badge/ring visibility while the ceremony hides all UI chrome
   *  (everything but the sprite itself and its floating text) — restored
   *  verbatim on teardown rather than forced true, since either could have
   *  been legitimately hidden already. */
  private chromeWasVisible: [badge: boolean, ring: boolean] | null = null;
  /** Guards the done-delegate recall action against duplicate clicks. */
  private recalling = false;

  constructor(opts: WalkerOptions) {
    this.sessionId = opts.sessionId;
    this.map = opts.map;
    this.reservations = opts.reservations;
    this.locomotion = opts.animation.info.locomotion;
    this.pinnedLive = opts.animation;
    pinAnimation(this.pinnedLive);
    this.dimLayer = opts.dimLayer;
    this.flashLayer = opts.flashLayer;
    this.ceremonyLayer = opts.ceremonyLayer;

    const ts = this.map.tileSize;
    this.px = opts.startTile.x * ts + ts / 2;
    this.py = opts.startTile.y * ts + ts;
    // Claim this walker's own starting anchor immediately — every OTHER
    // walker's separation check (updateWander's idle branch, below) reads
    // `reservations` from frame one, so a walker that hasn't registered yet
    // would look like free space to them.
    this.reservations.setAnchor(this.sessionId, opts.startTile);
    // Roll a fresh delay instead of leaving the class-field default
    // (WANDER_MIN_DELAY, 1.5s) — otherwise every walker constructed this
    // generation (in particular a whole batch of restored idle sessions,
    // added back-to-back in the same synchronous pass) starts its very
    // first wander timer at 0 with the SAME 1.5s delay, so they'd all take
    // their first step on the same frame instead of staggering. Uses
    // `status`'s field-initializer value ('starting', set above the
    // constructor — see that field's own comment), which reads as
    // non-working here regardless of what the session's real status turns
    // out to be moments later, so this always rolls the wider IDLE range;
    // harmless either way, since this only affects how soon the FIRST leg
    // fires.
    this.wanderDelay = this.rollWanderDelay();

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
      style: {
        fontSize: 16,
        fontFamily: 'monospace',
        fill: '#f4ffe8',
        stroke: { color: 0x1b1b1b, width: 3 },
        align: 'center'
      }
    });
    this.nameTag.scale.set(0.35);
    this.nameTag.anchor.set(0.5, 0);
    this.nameTag.y = 4;

    this.bubble = new ToolBubble('main');
    this.floatLayer = new Container();

    this.zzz = new Text({
      text: 'z z z',
      style: {
        fontSize: 16,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fill: '#dfe9ff',
        stroke: { color: 0x1b1b1b, width: 3 },
        align: 'center'
      }
    });
    this.zzz.scale.set(0.35);
    this.zzz.anchor.set(0.5, 1);
    this.zzz.visible = false;

    this.container.addChild(
      this.selectionRing,
      this.sprite.container,
      this.badge,
      this.nameTag,
      this.zzz,
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
    this.zzz.y = -this.sprite.drawnHeight - 6;

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

  /** Play the shared pokéball recall sequence over this session walker. The
   *  inner sprite container is passed separately so the ball holds its size
   *  while the Pokemon shrinks, exactly as it does for a subagent Battler. */
  startRecall(onDone: () => void): void {
    if (this.recalling) return;
    this.recalling = true;
    this.path = [];
    this.walking = false;
    this.wandering = false;
    this.sprite.setMoving(false);
    this.hideBubble();
    this.setSelected(false);
    spawnPokeballRecall(this.container, this.sprite.container, this.spriteHeight, onDone);
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
    markDirty();
  }

  /** Kick off the select hop (Phase 8 §4) — a single sine arc, restarted from
   *  0 if already mid-hop rather than queued, so a rapid run of selections
   *  never stacks up a backlog of hops to play out. */
  bounce(): void {
    this.bounceT = 0;
  }

  setLabel(label: string): void {
    this.nameTag.text = label;
    markDirty();
  }

  /** Walk to a tile. Wandering stops until the walker is put back into it.
   *  Returns false when the tile is unreachable, so the caller can retry on the
   *  next status change rather than believing the walker is on its way.
   *  Also returns false — same "retry later" contract — while an evolution
   *  ceremony is running: the walker is exclusive/uninterruptible for its
   *  duration. Claims `tile` as this walker's anchor the moment the path is
   *  accepted (wanderReservations.ts) — ahead of actually arriving, same as
   *  `tryStartWander`'s own idle-wander pick — so a battle stand tile or a
   *  berry bush is reserved for the whole approach walk, not just once the
   *  walker gets there. */
  goTo(tile: { x: number; y: number }): boolean {
    if (this.ceremony || this.napping) return false;
    const path = findPath(this.map, this.tile, tile, this.canEnter);
    if (!path) return false; // unreachable — stay put rather than teleport
    this.wandering = false;
    if (this.tracked) this.reservations.setAnchor(this.sessionId, tile);
    // `findPath` returns `[]` whenever start === goal — including when
    // `tile` is the tile under our feet RIGHT NOW while mid-segment (still
    // possible to walk, just not yet arrived at its own centre/feet anchor;
    // see `tile`'s own comment). An empty path with nothing already queued
    // (`this.path` was already `[]`) is a genuine "already there, stay
    // frozen exactly here" — BattleManager's alert beat relies on that
    // (`goTo(walker.tile)` to freeze an in-flight wander without moving it,
    // see admitBattle's own comment). But an empty path that's REPLACING an
    // in-flight segment (`this.path.length > 0`, e.g. a battle/errand
    // routing a walker back onto the tile it's mid-stride out of) would
    // otherwise leave it parked off-grid — up to half a tile short of
    // `tile`'s actual anchor point — for as long as nothing else moves it.
    // Walk the short remaining distance onto the tile's centre instead.
    this.path = path.length === 0 && this.path.length > 0 ? [tile] : path;
    this.walking = this.path.length > 0;
    this.sprite.setMoving(this.walking);
    return true;
  }

  /** Where this Pokemon may go. Fliers add the pond to the walkable grid; they
   *  do not get a grid of their own, so the map stays the one source of truth.
   *  Public so wanderReservations.ts's spawn-spread search and battle/errand
   *  code can search candidate tiles with the SAME walkability rule
   *  `goTo`/`findPath` actually use, rather than keeping a second,
   *  easily-drifting copy of this rule. */
  canEnter = (x: number, y: number): boolean =>
    this.map.isWalkable(x, y) || (this.canFly && this.map.isWater(x, y));

  /** The wait, in seconds, before the NEXT wander leg fires once the current
   *  one ends — brisk for a working walker's free-roam, more relaxed for a
   *  non-working one's amble (see the constants' own comments). Read at the
   *  moment a new delay is rolled, both here and in `updateWander`, so it
   *  always reflects `status` as of THAT roll rather than whatever it was
   *  the last time `beginWander` ran. */
  private rollWanderDelay(): number {
    const [min, max] =
      this.status === 'working' ? [WANDER_MIN_DELAY, WANDER_MAX_DELAY] : [IDLE_WANDER_MIN_DELAY, IDLE_WANDER_MAX_DELAY];
    return min + Math.random() * (max - min);
  }

  /** Resume aimless strolling, free-roaming anywhere on the map — a working
   *  walker's brisk free-roam or a non-working walker's relaxed amble alike
   *  (see `updateWander`'s own branch on `status`). Any errand in flight is
   *  truncated to its current step: dropping the path outright would strand
   *  the sprite between tiles, and running it to completion would make a
   *  walker visibly finish an errand it is no longer on. A no-op while
   *  something else owns this walker's position (`busy` — a battle,
   *  challenger, berry errand, or recall) or it's napping/mid-ceremony; the
   *  owning system (or `setNapping`/the ceremony's own completion) calls
   *  this again once it lets go. */
  beginWander(): void {
    if (this.ceremony || this.napping || this.busy) return;
    this.path = this.path.slice(0, 1);
    this.wandering = true;
    this.wanderTimer = 0;
    this.wanderDelay = this.rollWanderDelay();
  }

  /** Something other than this walker's own wander loop now owns (or has
   *  released) its position — a battle, a delegate challenge, a berry
   *  errand, or the pokéball recall. Setting it true stops `update()` from
   *  starting any NEW autonomous wander leg (see its own `!this.busy`
   *  check) and keeps `beginWander()` from resuming; it deliberately does
   *  NOT truncate an in-flight `path` the way `stayPut()` does — the owning
   *  system asserts control with its own `goTo()` call(s) at its own
   *  timing (immediately, in the same tick this goes true, or a little
   *  later), and `goTo()` always cleanly replaces whatever path was already
   *  there. Calling `stayPut()` here too would risk truncating an
   *  errand/approach path THAT SAME goTo() just set up, if this fires after
   *  it — see GardenCharm's berry errand and WalkerChallenger's approach.
   *
   *  Setting it false on the true -> false EDGE also resumes wandering
   *  itself (`beginWander()`, itself a no-op if napping/mid-ceremony) —
   *  `beginWander()` alone can NEVER do this on its own behalf, since its
   *  own guard returns immediately while `busy` is still true, which is
   *  exactly when a hand-back needs it to fire. So the two sites that KNOW
   *  the instant ownership ends (BattleManager's onBattleEnd, GardenCharm's
   *  errand completion) call `setBusy(false)` themselves for a same-tick
   *  resume, rather than waiting on GardenScene's reconcile to eventually
   *  notice; this edge-trigger is what makes that call actually work. The
   *  edge-trigger is ALSO GardenScene's own fallback, for the one release
   *  path that hands a walker back WITHOUT any explicit resume call —
   *  BattleManager's `releaseDelegate` (a delegate's own walker coming off
   *  a completion battle) — via the reconcile's own `setBusy(positionOwnedElsewhere)`
   *  call, every pass, once `isChallenger` finally reads false for it.
   *  Edge-triggered ON PURPOSE, not "false -> resume every time": that
   *  reconcile call happens every pass regardless, and re-firing
   *  `beginWander()` (which resets the wander timer) on every one of those
   *  while already free would be exactly the per-reconcile churn this whole
   *  rework set out to remove. */
  setBusy(busy: boolean): void {
    const wasBusy = this.busy;
    this.busy = busy;
    if (wasBusy && !busy) this.beginWander();
  }

  /** Whether this walker's session is in the ACTIVE workspace right now —
   *  see `tracked`'s own comment. Guarded the same way `setBusy` is: a no-op
   *  on repeat calls with the same value, so GardenScene's reconcile can
   *  call this unconditionally every pass without spamming
   *  `reservations` writes. */
  setTracked(tracked: boolean): void {
    if (tracked === this.tracked) return;
    this.tracked = tracked;
    if (tracked) this.reservations.setAnchor(this.sessionId, this.tile);
    else this.reservations.release(this.sessionId);
  }

  /** Stop ordinary garden movement after the current in-flight segment.
   *  Keep that segment's target so updateWalk() can finish on the tile; when
   *  already stopped, also stop the moving animation. Explicit choreography
   *  (battles/closing) can still use goTo directly. */
  stayPut(): void {
    if (this.ceremony) return;
    this.path = this.path.slice(0, 1);
    this.wandering = false;
    if (this.path.length === 0) {
      this.walking = false;
      this.sprite.setMoving(false);
    }
  }

  /** Working <-> idle/starting/done no longer interrupts movement — all
   *  three keep wandering (see `updateWander`'s branch on `status`), just at
   *  a different pace, which `updateWalk`/`updateWander` read live off
   *  `status` every frame.
   *
   *  `'blocked'` is the one exception (user decision, 2026-09-18): it means
   *  this session needs YOU — waiting on input, a permission prompt, etc. —
   *  and a Pokemon that keeps ambling across the map while it waits is
   *  exactly what makes it hard to spot and click. Entering `'blocked'`
   *  stands it still in place (`stayPut()`, which also clears `wandering` so
   *  `update()`'s dispatch won't start a new leg — see its own `!this.busy`
   *  check, same mechanism); leaving it resumes wandering (`beginWander()`)
   *  — this is NOT a one-liner for exactly that reason: `stayPut()` clears
   *  `wandering`, and nothing else would ever set it back to true again once
   *  the session stops being blocked, so the resume call is load-bearing,
   *  not optional. Both are no-ops while something else owns the walker
   *  (`busy`) or mid-ceremony — same guards `beginWander()`/`stayPut()`
   *  always had; if a blocked session somehow also started a battle, the
   *  battle still wins and this resolves itself the moment `busy` clears.
   *  `'starting'` and `'done'` are deliberately NOT stand-still: `'starting'`
   *  is a transient pre-work state, not something needing attention; `'done'`
   *  is treated exactly like `'idle'` and keeps roaming until the player
   *  recalls it or it starts a fresh delegate/completion battle. */
  setStatus(status: SessionStatus): void {
    if (status === this.status) return;
    const wasBlocked = this.status === 'blocked';
    this.status = status;
    if (status === 'blocked') {
      this.stayPut();
    } else if (wasBlocked) {
      this.beginWander();
    }
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
    // The ceremony now owns the sprite exclusively (file header invariant) —
    // a mega flash's pending swap firing mid-ceremony would fight it for the
    // same texture. `setAnimation`'s own applySwap call (this ceremony's
    // eventual reveal) already clears `tempFormBase` for us; this just makes
    // sure nothing STILL IN FLIGHT sneaks a sprite.configure() in between.
    this.cancelMegaFlash();
    // Same reasoning for a staged mega ceremony still building up: it decorates
    // (and fades) the very sprite the evolution ceremony is about to take over.
    // Cancel-without-applying — the mega form it was about to reveal is
    // superseded by the species this walker is evolving into.
    this.cancelMegaCeremony();
    // The ceremony shows `nextAnimation` (via silhouette) for its whole ~15s
    // buildup, well before `setAnimation` (its own reveal, below) ever runs —
    // pin it now so lazySprites.ts's eviction can't destroy it out from under
    // a ceremony that's still mid-flight. `setAnimation` transfers this pin
    // to `pinnedLive` at the reveal; `destroy()` releases it if the ceremony
    // is aborted before that.
    this.pinnedEvolveTarget = nextAnimation;
    pinAnimation(nextAnimation);
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

  get isNapping(): boolean {
    return this.napping;
  }

  /** Named `isRecalling`, not `recalling`, to match the `isEvolving`/
   *  `isNapping` getters above — a getter can't share its private
   *  backing field's own name. GardenScene.tsx's `positionOwnedElsewhere`
   *  needs this alongside `isBattling`/`isChallenger`/`isBusy`, feeding
   *  `walker.setBusy(...)`: `startRecall` already clears `path`/`wandering`
   *  itself and the shrink animation doesn't move the walker again, so this
   *  is mostly redundant with that — but it's what keeps this walker's OWN
   *  wander loop (`update()`'s `!this.busy` dispatch check) from starting a
   *  fresh leg out from under the ~1s pokéball shrink for the brief window
   *  after `startRecall()` runs and before the session is actually torn down
   *  (`removeWalker`). */
  get isRecalling(): boolean {
    return this.recalling;
  }

  /** Enter/leave the nap pose (Phase 8.5 Wave B items 3/4). Waking plays the
   *  existing select-hop (`bounce()`) as the "stretch" beat the spec asks
   *  for, then always resumes wandering — working's brisk free-roam or a
   *  non-working walker's relaxed amble alike (see `beginWander`'s own
   *  comment) — reusing beginWander/bounce rather than adding new animation
   *  machinery. A no-op mid-ceremony: the ceremony already owns the walker
   *  exclusively for its duration (see goTo/beginWander's own ceremony
   *  guards), and this napping/waking mustn't fight it — GardenScene's
   *  reconcile calls setNapping again on the next tick once the ceremony
   *  ends. */
  setNapping(napping: boolean): void {
    if (napping === this.napping || this.ceremony) return;
    this.napping = napping;
    if (napping) {
      this.stayPut();
      this.zzz.visible = true;
      this.zzzT = 0;
    } else {
      this.zzz.visible = false;
      this.bounce();
      this.beginWander();
    }
    // The visible toggle above isn't guaranteed to land alongside a position/
    // texture change this same frame (a walker that was already stationary
    // and front-facing has nothing else to mark stayPut()/bounce() dirty
    // with) — explicit here so the "z z z" popping in/out is never the one
    // frame render-on-change silently skips.
    markDirty();
  }

  /** Instant, no-flash art swap — used when a lazily-fetched species' real
   *  sprite finishes loading after the walker already spawned with a
   *  pokeball placeholder. (Evolution's own swap goes through the flash
   *  sequence instead; see evolve().) */
  setAnimation(animation: PokemonAnimation): void {
    // This IS the new base now — drop any mega-evolution bookkeeping rather
    // than let a later revert restore a form this call has already
    // superseded (evolving, or a fresh lazy sprite landing, mid-battle).
    this.cancelMegaFlash();
    this.cancelMegaCeremony();
    this.setTempFormBase(null);
    this.swapPinnedLive(animation);
    if (this.pinnedEvolveTarget === animation) {
      // The evolution ceremony's own reveal — its buildup-long reservation
      // (see evolve()) is now covered by `pinnedLive` above, so release it.
      unpinAnimation(this.pinnedEvolveTarget);
      this.pinnedEvolveTarget = null;
    }
    this.sprite.configure(animation);
    this.locomotion = animation.info.locomotion;
    this.layoutForSprite();
  }

  /** Transfers the `pinnedLive` protection (lazySprites.ts's eviction guard)
   *  from whatever this walker was showing to `next` — the one place every
   *  live sprite swap (setAnimation, applyTempForm) must route through so
   *  the outgoing species is never unprotected before the incoming one is. */
  private swapPinnedLive(next: PokemonAnimation): void {
    if (next === this.pinnedLive) return;
    pinAnimation(next);
    unpinAnimation(this.pinnedLive);
    this.pinnedLive = next;
  }

  /** Assigns `tempFormBase`, keeping its lazySprites.ts pin in lockstep with
   *  the field itself — non-null for exactly as long as this walker needs a
   *  mega-evolution base to revert to (see that field's own comment). */
  private setTempFormBase(value: PokemonAnimation | null): void {
    if (value === this.tempFormBase) return;
    if (value) pinAnimation(value);
    const old = this.tempFormBase;
    this.tempFormBase = value;
    if (old) unpinAnimation(old);
  }

  /** Battle-only mega evolution's sprite swap (BattleManager's
   *  startMega/revertMega) — same runtime configure() swap `setAnimation`
   *  uses, but remembers what was showing before so a later call with
   *  `null` restores it exactly. Wrapped in a short flash rather than an
   *  instant cut — see flashSwap(). A no-op while an evolution ceremony owns
   *  the sprite (file header invariant): the caller (BattleManager) is expected to
   *  check `isEvolving` itself before calling this, and if evolution starts
   *  anyway while a mega is active, `setAnimation`'s own reset above already
   *  makes a later `setTemporaryForm(null)` a harmless no-op (nothing left
   *  to revert to). Passing `null` when no temporary form is active is also
   *  a no-op — safe to call unconditionally on every battle-end/teardown
   *  path. */
  setTemporaryForm(animation: PokemonAnimation | null): void {
    if (this.ceremony) return;
    // Whatever this call is about to do, the staged ceremony no longer gets
    // to finish its own version of it. Cancelling BEFORE the `tempFormBase`
    // check below is the abort-without-applying path (see that field's
    // invariant): a ceremony that never reached its flash peak leaves
    // `tempFormBase` null, so the revert branch correctly finds nothing to
    // revert instead of applying the pending mega and immediately undoing it.
    this.cancelMegaCeremony();
    if (animation) {
      // Keep the ORIGINAL base if a mega is somehow re-triggered before its
      // own revert — never overwrite it with whatever's showing mid-swap.
      if (!this.tempFormBase) this.setTempFormBase(this.sprite.animation);
      this.flashSwap(() => this.applyTempForm(animation));
    } else {
      if (!this.tempFormBase) return;
      const base = this.tempFormBase;
      // `tempFormBase` (and its pin) is deliberately NOT cleared here: `base`
      // still needs lazySprites.ts protection for the flash's async gap
      // (flashSwap can cancel a pending swap and re-fire it later, or force-
      // complete an OLDER pending one first — see flashSwap's own re-entrancy
      // branch). Cleared inside the closure below, right after `base` is
      // actually applied (and thus already re-protected as `pinnedLive`).
      this.flashSwap(() => {
        this.applyTempForm(base);
        this.setTempFormBase(null);
      });
    }
  }

  /** Battle mega evolution's REAL entry point (BattleManager.startMega) — the
   *  staged ceremony (battle/MegaCeremony.ts) rather than `setTemporaryForm`'s
   *  bare half-second flash. The caller holds its battle wave in place while
   *  `isMegaCeremonyActive` stays true, exactly the way `updateAlert` holds a
   *  wave until the "!" bubble finishes; `onSwap` fires at the ceremony's
   *  flash peak, the frame the mega form actually appears, so the "Mega
   *  Evolved!" text lands with the reveal instead of ahead of it.
   *
   *  Under `prefers-reduced-motion` there IS no buildup: the swap is applied
   *  instantly via `setTemporaryForm` and `isMegaCeremonyActive` is false from
   *  the start, so the caller's hold is a no-op too — a reduced-motion viewer
   *  never sits through a multi-second pause with nothing to look at.
   *
   *  Returns false only when an evolution ceremony owns the sprite (file
   *  header invariant), in which case nothing at all was started. */
  startMegaCeremony(animation: PokemonAnimation, onSwap?: () => void): boolean {
    if (this.ceremony) return false;
    if (prefersReducedMotion()) {
      this.setTemporaryForm(animation);
      onSwap?.();
      return true;
    }
    // Never stack a ceremony on a still-running one (or on an in-flight
    // flash) — cancel-without-applying, then start fresh.
    this.cancelMegaCeremony();
    this.cancelMegaFlash();
    // Same buildup-long protection evolve() gives its own ceremony target —
    // the mega ceremony's silhouette shows `animation` well before
    // `applyMegaCeremonySwap` (its reveal) ever runs.
    this.pinnedMegaTarget = animation;
    pinAnimation(animation);
    this.megaCeremony = new MegaCeremony({
      container: this.container,
      sprite: this.sprite,
      flashLayer: this.flashLayer,
      spriteWidth: () => this.sprite.drawnWidth,
      spriteHeight: () => this.sprite.drawnHeight,
      feet: () => ({ x: Math.round(this.px), y: Math.round(this.py) }),
      applySwap: () => {
        this.applyMegaCeremonySwap(animation);
        onSwap?.();
      }
    });
    return true;
  }

  /** True while the staged mega ceremony is mid-flight — the flag
   *  BattleManager gates its wave-hold on. */
  get isMegaCeremonyActive(): boolean {
    return this.megaCeremony !== null;
  }

  /** The ceremony's flash-peak swap. Deliberately NOT routed through
   *  `setTemporaryForm`: that cancels the ceremony as its first act, which
   *  would dispose the very object currently mid-`update()`. */
  private applyMegaCeremonySwap(animation: PokemonAnimation): void {
    if (!this.tempFormBase) this.setTempFormBase(this.sprite.animation);
    this.applyTempForm(animation);
    if (this.pinnedMegaTarget === animation) {
      // applyTempForm above already re-protects `animation` as `pinnedLive`
      // — release the ceremony's own buildup-long reservation (startMegaCeremony).
      unpinAnimation(this.pinnedMegaTarget);
      this.pinnedMegaTarget = null;
    }
  }

  /** Drop a staged mega ceremony without ever performing its pending swap
   *  (if it hasn't reached its flash peak yet) — the abort path, reached from
   *  `setTemporaryForm(null)` (i.e. BattleManager's `revertMega`), from
   *  `evolve`/`setAnimation` seizing the sprite, and from teardown. Safe to
   *  call when nothing is running. When the ceremony HAS already swapped,
   *  `tempFormBase` is set and the caller's normal revert still runs. */
  private cancelMegaCeremony(): void {
    this.megaCeremony?.dispose();
    this.megaCeremony = null;
    if (this.pinnedMegaTarget) {
      // Aborted before applyMegaCeremonySwap ever ran (dispose() tears down
      // without applying, same as EvolutionCeremony — see its own comment) —
      // this reservation was never transferred to `pinnedLive`, so release it
      // here instead or it would stay pinned forever.
      unpinAnimation(this.pinnedMegaTarget);
      this.pinnedMegaTarget = null;
    }
  }

  private applyTempForm(animation: PokemonAnimation): void {
    this.swapPinnedLive(animation);
    this.sprite.configure(animation);
    this.layoutForSprite();
  }

  /** A half-second white pulse over the sprite's own footprint, the actual
   *  swap firing at its peak — a lighter cousin of the full evolution
   *  ceremony's map-wide flash-out (EvolutionCeremony.ts), which would be
   *  far too heavy for a twice-a-battle beat. Instant (no flash) under
   *  prefers-reduced-motion, same convention battleFx.ts uses. Lives in the
   *  shared flashLayer (not this walker's own container) so it draws above
   *  every character regardless of depth-sort. */
  private flashSwap(apply: () => void): void {
    if (prefersReducedMotion()) {
      this.cancelMegaFlash();
      apply();
      return;
    }
    if (this.megaFlashT !== null) {
      // Already mid-flash (rapid re-trigger edge case) — finish its own
      // pending swap right now rather than stack a second flash on top.
      this.megaFlashSwap?.();
      this.cancelMegaFlash();
    }
    this.megaFlashT = 0;
    this.megaFlashSwap = apply;
    const g = new Graphics();
    const w = Math.max(this.sprite.drawnWidth * 1.3, 16);
    const h = Math.max(this.sprite.drawnHeight * 1.3, 16);
    g.rect(-w / 2, -h, w, h).fill({ color: 0xffffff, alpha: 1 });
    g.alpha = 0;
    g.x = Math.round(this.px);
    g.y = Math.round(this.py);
    this.flashLayer.addChild(g);
    this.megaFlashGraphic = g;
  }

  private updateMegaFlash(dt: number): void {
    if (this.megaFlashT === null) return;
    const g = this.megaFlashGraphic;
    if (!g) {
      this.megaFlashT = null;
      return;
    }
    this.megaFlashT += dt * 1000;
    g.x = Math.round(this.px);
    g.y = Math.round(this.py);
    const half = Walker.MEGA_FLASH_MS / 2;
    if (this.megaFlashT < half) {
      g.alpha = this.megaFlashT / half;
    } else {
      if (this.megaFlashSwap) {
        const swap = this.megaFlashSwap;
        this.megaFlashSwap = null;
        swap();
      }
      g.alpha = Math.max(0, 1 - (this.megaFlashT - half) / half);
    }
    if (this.megaFlashT >= Walker.MEGA_FLASH_MS) this.cancelMegaFlash();
  }

  /** Discard any in-flight mega flash without necessarily having applied its
   *  pending swap — used when something else (evolution starting, a fresh
   *  setAnimation, walker teardown) needs to seize the sprite/graphics layer
   *  before the flash would have finished on its own. Safe to call when
   *  nothing is running. */
  private cancelMegaFlash(): void {
    this.megaFlashSwap = null;
    this.megaFlashGraphic?.destroy();
    this.megaFlashGraphic = null;
    this.megaFlashT = null;
  }

  update(dt: number): void {
    if (this.ceremony) {
      this.ceremony.update(dt);
      // Dirty-flag rendering (renderDirty.ts) — the ceremony has its own
      // multi-phase animated timeline (flash/silhouette/oscillate/lock/
      // flash-out, see EvolutionCeremony.ts) with no single property worth
      // instrumenting piecemeal; "a ceremony is running" is itself a clear
      // enough active flag to mark dirty every frame it's true, same
      // shortcut BattleManager takes below in GardenScene.tsx.
      markDirty();
      if (this.ceremony.done) {
        this.ceremony = null;
        // `wandering`/`path` survived the ceremony completely untouched (the
        // walk/wander branch below is skipped outright while `ceremony` is
        // set) — every walker is SUPPOSED to keep wandering once its
        // ceremony ends, working or not (see `updateWander`'s branch on
        // `status`), so there is nothing to reset here now: it just resumes
        // on the very next frame via the normal `walking`/`wandering` check
        // below.
      }
    } else {
      if (this.walking) this.updateWalk(dt);
      // `!this.busy`: while something else owns this walker's position (a
      // battle, a delegate challenge, a berry errand, or a recall), don't
      // start a NEW autonomous wander leg — but don't touch `path`/`walking`
      // here either (see `setBusy`'s own comment for why not): whatever leg
      // is already in flight, self-initiated or set by an external `goTo()`,
      // keeps running via the branch above until it completes on its own.
      else if (this.wandering && !this.busy) this.updateWander(dt);
      this.sprite.update(dt); // marks dirty itself on frame-step/bob — see WalkerSprite.ts
    }
    // Runs regardless of ceremony state — cancelMegaFlash() at evolve()'s
    // own start already guarantees nothing is in flight the instant a
    // ceremony begins owning the sprite, so this has nothing left to step
    // once one is.
    this.updateMegaFlash(dt);
    if (this.megaFlashT !== null) markDirty(); // g.alpha/g.x/g.y step every frame it's in flight
    if (this.megaCeremony) {
      this.megaCeremony.update(dt);
      // Dirty-flag rendering (renderDirty.ts) — same blanket "a ceremony is
      // running is itself the active flag" shortcut the evolution ceremony
      // takes above: its orbs/ring/plumes/core all animate every frame, with
      // no single property worth instrumenting piecemeal.
      markDirty();
      if (this.megaCeremony.done) this.megaCeremony = null;
    }
    this.updateFloatingText(dt);
    if (this.floatLayer.children.length > 0) markDirty(); // y/alpha tween every frame text is up

    if (this.napping) {
      this.zzzT += dt;
      this.zzz.y = -this.sprite.drawnHeight - 6 - Math.sin(this.zzzT * 1.6) * 2;
      this.zzz.alpha = 0.65 + 0.35 * Math.sin(this.zzzT * 1.6);
      this.nappingZzzFrame = (this.nappingZzzFrame + 1) % Walker.IDLE_ANIM_DIRTY_EVERY_N_FRAMES;
      if (this.nappingZzzFrame === 0) markDirty();
    }

    if (this.status === 'blocked') {
      this.badgePulse += dt;
      this.badge.alpha = 0.55 + 0.45 * Math.sin(this.badgePulse * 6);
      this.blockedBadgeFrame = (this.blockedBadgeFrame + 1) % Walker.IDLE_ANIM_DIRTY_EVERY_N_FRAMES;
      if (this.blockedBadgeFrame === 0) markDirty();
    }

    this.bubble.update(dt); // ToolBubble marks dirty itself on any visible change — see ToolBubble.ts
    // Above the head, not the feet: these sprites are several tiles tall, and a
    // foot-anchored bubble would sit across the Pokemon's chest.
    this.bubble.setPosition(this.px, this.py - this.sprite.drawnHeight);
    // Keep the bubble in the same "always above ordinary sprite bodies"
    // overlay tier as before (TOOL_BUBBLE_Z_BASE), but now Y-sorted by its
    // OWN walker's feet within that tier — rather than a flat identical
    // value for every bubble — so an advisor companion (which sorts into
    // this same tier at parentPy + 1, see AdvisorManager.positionCompanion)
    // can win specifically against ITS OWN parent's bubble without having
    // to unconditionally out-rank every bubble in the garden.
    this.bubble.container.zIndex = TOOL_BUBBLE_Z_BASE + Math.round(this.py);

    if (this.bounceT !== null) {
      this.bounceT += dt;
      const t = Math.min(1, this.bounceT / Walker.BOUNCE_DURATION);
      this.sprite.container.y = -Math.sin(t * Math.PI) * Walker.BOUNCE_HEIGHT;
      if (t >= 1) {
        this.bounceT = null;
        this.sprite.container.y = 0;
      }
      markDirty();
    }
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
      // Re-anchor ONLY on the FINAL arrival (`this.path` is now empty —
      // checked AFTER the shift above), not on every intermediate node a
      // multi-tile path passes through. `goTo`/`tryStartWander` already
      // anchor at the true destination the moment a leg is accepted; if
      // this ran on every node too, it would overwrite that destination
      // anchor with whatever tile is merely being passed through roughly
      // once a second (a tile at idle speed), freeing the REAL destination
      // for a DIFFERENT idle walker to also pick for the rest of this leg
      // — the walker only reclaims it once it actually gets there. Every
      // walker still ends up with an accurate resting-spot anchor once it
      // stops, working or not, so an idle walker's separation search
      // (below) can see where a working one currently is too. Skipped
      // while untracked (an inactive workspace's walker keeps moving
      // off-stage, but stops counting toward on-stage spacing — see
      // `setTracked`).
      if (this.tracked && this.path.length === 0) this.reservations.setAnchor(this.sessionId, target);
      return;
    }

    const step = Math.min(this.currentSpeed() * dt, dist);
    this.px += (dx / dist) * step;
    this.py += (dy / dist) * step;
    // Only horizontal travel changes left/right facing: there is no side view
    // to turn to, so a walker heading straight up or down keeps the way it was
    // already pointing.
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? 'right' : 'left';
      this.sprite.setFacing(this.facing);
    }
    this.sprite.setMoving(true);
    this.syncPosition();
  }

  /** Walk speed, px/sec — full pace for a working walker's free-roam OR
   *  whenever something else is choreographing this walker (`busy`: a
   *  battle approach, a berry errand, ...) — those already have their own
   *  timing (BattleManager's stuck-watchdog thresholds, GardenCharm's
   *  ERRAND_TIMEOUT_S) tuned to the ordinary pace, and slowing them down
   *  would be a real behavior change, not a cosmetic one. Only a genuinely
   *  unsupervised idle amble gets the relaxed IDLE_SPEED_FACTOR. Read live
   *  every step, so a status/busy change mid-leg changes pace immediately
   *  rather than only on the walker's NEXT leg. */
  private currentSpeed(): number {
    return this.status === 'working' || this.busy ? SPEED : SPEED * IDLE_SPEED_FACTOR;
  }

  /** Picks the walker's next wander leg once `wanderDelay` elapses — a
   *  working walker's brisk, uncoordinated free-roam anywhere on the map
   *  (unchanged from before this file's wander/idle-placement rework), or a
   *  non-working walker's relaxed amble, which ALSO goes anywhere on the
   *  map but keeps its destination spaced out from every other walker's own
   *  anchor via `reservations` (see wanderReservations.ts) so idle walkers
   *  spread across the garden instead of converging on the same spot. */
  private updateWander(dt: number): void {
    this.wanderTimer += dt;
    if (this.wanderTimer < this.wanderDelay) return;
    this.wanderTimer = 0;
    this.wanderDelay = this.rollWanderDelay();

    if (this.status === 'working') {
      this.updateWorkingWander();
    } else {
      this.updateIdleWander();
    }
  }

  private updateWorkingWander(): void {
    const cur = this.tile;
    for (let attempt = 0; attempt < 16; attempt++) {
      const tx = Math.floor(Math.random() * this.map.width);
      const ty = Math.floor(Math.random() * this.map.height);
      if ((tx === cur.x && ty === cur.y) || !this.canEnter(tx, ty)) continue;
      const path = findPath(this.map, cur, { x: tx, y: ty }, this.canEnter);
      if (!path || path.length === 0) continue;
      this.path = path;
      this.walking = true;
      this.sprite.setMoving(true);
      return;
    }
  }

  /** Non-working wander leg: try up to IDLE_WANDER_ATTEMPTS random
   *  reachable tiles anywhere on the map, taking the FIRST one that clears
   *  MIN_SEPARATION_TILES from every other walker's anchor (one pathfind —
   *  the common case). If nothing clears the bar within budget (a small or
   *  heavily-populated map), falls back to whichever candidate had the most
   *  clearance instead of leaving this walker frozen. Claims the chosen
   *  destination as this walker's own anchor immediately (ahead of actually
   *  arriving), so a DIFFERENT idle walker deciding in the same frame won't
   *  also target it. */
  private updateIdleWander(): void {
    const from = this.tile;
    let fallback: { x: number; y: number } | null = null;
    let fallbackDist = -Infinity;

    for (let attempt = 0; attempt < IDLE_WANDER_ATTEMPTS; attempt++) {
      const tx = Math.floor(Math.random() * this.map.width);
      const ty = Math.floor(Math.random() * this.map.height);
      if ((tx === from.x && ty === from.y) || !this.canEnter(tx, ty)) continue;
      const candidate = { x: tx, y: ty };
      const dist = this.reservations.distanceToNearest(candidate, this.sessionId);
      if (dist >= MIN_SEPARATION_TILES) {
        if (this.tryStartWander(from, candidate)) return;
        continue; // separated but unreachable (fence/pond) — try another
      }
      if (dist > fallbackDist) {
        fallbackDist = dist;
        fallback = candidate;
      }
    }
    if (fallback) this.tryStartWander(from, fallback);
    // Nothing panned out this tick (heavily crowded or blocked map) — stay
    // put; the next `wanderDelay` retries with a fresh random draw.
  }

  /** Shared by `updateIdleWander`'s primary and fallback picks: pathfind to
   *  `dest`, and if reachable, claim it as this walker's anchor and start
   *  walking. Returns whether it actually started. */
  private tryStartWander(from: { x: number; y: number }, dest: { x: number; y: number }): boolean {
    const path = findPath(this.map, from, dest, this.canEnter);
    if (!path || path.length === 0) return false;
    if (this.tracked) this.reservations.setAnchor(this.sessionId, dest);
    this.path = path;
    this.walking = true;
    this.sprite.setMoving(true);
    return true;
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
    // Dirty-flag rendering (renderDirty.ts) — the explicit, direct source
    // for "position changes" (updateWalk/goTo's own completion branch both
    // funnel through here). Not relying on WalkerSprite's own bob-driven
    // markDirty as a proxy for movement: every locomotion currently bobs
    // while moving, so it would happen to cover this today, but that's an
    // incidental coupling, not a guarantee.
    markDirty();
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
    markDirty();
  }

  destroy(): void {
    // Release this walker's wander anchor — same reasoning as every other
    // release below: without this, a destroyed walker's last spot would
    // stay "occupied" forever, slowly starving idle walkers' separation
    // search of legal destinations.
    this.reservations.release(this.sessionId);
    // A ceremony in flight owns overlay graphics living in the SHARED
    // overlayLayer, outside this walker's own container — dispose it first so
    // that overlay doesn't outlive the walker it was dimming the garden for.
    purgeBattleFxFor(this.container);
    this.ceremony?.dispose();
    this.ceremony = null;
    // Same reasoning for a mega flash mid-flight: its graphic also lives in
    // the shared flashLayer, not this walker's own (about to be destroyed)
    // container, so it would otherwise survive this walker as an orphaned
    // white rect.
    this.cancelMegaFlash();
    // Same for a staged mega ceremony: its flash-out burst also lives in the
    // shared flashLayer, and its teardown is what puts the body's alpha back.
    // (Also releases `pinnedMegaTarget` if the ceremony was still mid-buildup.)
    this.cancelMegaCeremony();
    // Release every lazySprites.ts pin this walker still holds — a live
    // sprite's (pinnedLive), and any still-staged evolution target
    // (pinnedEvolveTarget) or mega-revert base (tempFormBase) a ceremony
    // left behind. Without this, destroying a walker mid-ceremony would
    // leave its species permanently un-evictable.
    this.setTempFormBase(null);
    if (this.pinnedEvolveTarget) {
      unpinAnimation(this.pinnedEvolveTarget);
      this.pinnedEvolveTarget = null;
    }
    unpinAnimation(this.pinnedLive);
    this.bubble.destroy();
    this.container.destroy({ children: true });
  }
}
