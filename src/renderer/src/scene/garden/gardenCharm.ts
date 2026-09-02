import { Container, Graphics } from 'pixi.js';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { Walker } from './Walker';
import type { SessionStatus } from '@shared/types';
import { pickBerryEatenLine, pickBerryErrandLine, pickIdleLine } from './gardenLines';
import { markDirty } from './renderDirty';

/**
 * Garden charm (Phase 8 §7): idle Pokemon occasionally wander to a berry
 * bush and pick a berry (the one implemented "errand" — see this file's
 * header note below on why watering-style errands didn't get a second,
 * separate mechanism), occasional in-character speech bubbles, and two
 * clickable props (a signpost hotspot over the map's existing signpost art,
 * and a hand-drawn well — this map has no well tile, see stations.ts/
 * gardenArt.ts). Pure charm: nothing here touches session state, hooks, or
 * evolution/battle logic — it only reads `Walker`'s existing public surface
 * (goTo/beginWander/showText/lingerBubble/showFloatingText/tile) and draws
 * its own decorative Pixi layer.
 *
 * Scope note: the brief calls for "idle errands (wander to garden props,
 * watering-style beats)" AND a separate berry economy where "idle Pokemon
 * walk over, pick, and carry/eat one." Both are the same shape of behavior
 * (walk to a prop, pause, small visual beat, resume wandering) — rather than
 * building two parallel errand systems, the berry-bush walk *is* the one
 * errand type implemented. See the Phase 8 report for the explicit trim.
 */

/** Bush/well/signpost anchors — existing wander/signpost spawn points
 *  (stations.ts), not new map data. See TiledMapRenderer's header on why:
 *  garden.tmj is generated (tools/gen-garden-map.cjs) and these are
 *  guaranteed-walkable tiles already reachable by pathfinding. */
const BUSH_SPAWNS = ['wander-1', 'wander-2'] as const;
const WELL_SPAWN = 'wander-3';
const SIGNPOST_SPAWN = 'signpost-1';

const MAX_BERRIES = 3;
const REGROW_INTERVAL_S = 40;
/** Give up on a stuck/unreachable errand rather than stranding the walker
 *  wander-less forever — defensive, should never actually trigger. */
const ERRAND_TIMEOUT_S = 20;
/** Chance per eligible 1s tick that an idle, non-busy walker starts a berry
 *  errand — kept low; this is ambient background charm, not a spectacle. */
const BERRY_CHANCE = 0.02;
/** Chance per eligible tick of a speech bubble instead (checked only when
 *  the berry roll above already missed). */
const CHATTER_CHANCE = 0.02;
/** Per-session cooldown range before the NEXT roll is even attempted, so one
 *  walker doesn't roll dice every single second of its idle life. */
const COOLDOWN_MIN_S = 8;
const COOLDOWN_MAX_S = 20;

interface BerryBush {
  tile: { x: number; y: number };
  px: number;
  py: number;
  berries: number;
  regrowAt: number; // charm-clock seconds
  sprite: Graphics;
}

interface CharmState {
  cooldownS: number;
  busy: boolean;
  bushIndex: number | null;
  busyElapsedS: number;
}

export interface GardenCharmOptions {
  map: TiledMapRenderer;
  /** Same layer walkers live in (`map.getCharacterContainer()`), so props
   *  depth-sort against them correctly. */
  layer: Container;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
}

/** Minimal session shape this module needs — decoupled from the app store's
 *  full `Session` type on purpose (see file header). */
export interface CharmSessionLike {
  id: string;
  status: SessionStatus;
}

/** One registered alpha "breathe" pulse — see `GardenCharm.pulse()`/
 *  `updatePulses()`. `lastAlpha255` is the last alpha this actually PAINTED,
 *  quantized to an 8-bit channel value; -1 (below any real alpha) so the
 *  very first `updatePulses()` call always applies and marks dirty. */
interface Pulse {
  g: Graphics;
  t: number;
  lastAlpha255: number;
}

export class GardenCharm {
  private map: TiledMapRenderer;
  private layer: Container;
  private propsLayer: Container;
  private bushes: BerryBush[] = [];
  private clockS = 0;
  private charmStates = new Map<string, CharmState>();
  private pulses: Pulse[] = [];
  /** Snapshot of `tick()`'s own `walkers` param, refreshed every call — the
   *  only thing `forceChatter`/`forceBerry` (in-app demo mode) need beyond
   *  what `tick()` already tracks, since neither is invoked from within a
   *  tick itself (demo.ts calls them directly, off a session id alone). */
  private lastWalkers: ReadonlyMap<string, Walker> = new Map();

  constructor(opts: GardenCharmOptions) {
    this.map = opts.map;
    this.layer = opts.layer;
    this.propsLayer = new Container();
    this.propsLayer.sortableChildren = true;
    this.layer.addChild(this.propsLayer);

    this.setupBushes();
    this.setupWell(opts.onOpenSettings);
    this.setupSignpost(opts.onOpenSessions);
  }

  private tileToWorld(tile: { x: number; y: number }): { px: number; py: number } {
    const ts = this.map.tileSize;
    // Feet-anchored convention Walker itself uses (bottom-center of tile) —
    // keeps props sitting on the ground the same way a walker standing there
    // would, not floating at the tile's top-left corner.
    return { px: tile.x * ts + ts / 2, py: tile.y * ts + ts };
  }

  private setupBushes(): void {
    for (const name of BUSH_SPAWNS) {
      const tile = this.map.getSpawnPoint(name);
      if (!tile) continue; // map variant without this spawn — skip, not fatal
      const { px, py } = this.tileToWorld(tile);
      const sprite = new Graphics();
      sprite.x = px;
      sprite.y = py;
      sprite.zIndex = py;
      this.propsLayer.addChild(sprite);
      const bush: BerryBush = { tile, px, py, berries: MAX_BERRIES, regrowAt: 0, sprite };
      this.redrawBush(bush);
      this.bushes.push(bush);
    }
  }

  /** Bush art (Phase 8 §5b re-pass): the original flat single-tone blob got
   *  lost against the map's own scattered red-flower/berry ground clutter
   *  near wander-2 specifically — same red-dots-on-green silhouette at a
   *  similar size and density, so the interactive bush read as one more
   *  fleck of decoration instead of a distinct prop. Fixed with the cheap
   *  tricks that separate a "thing" from "texture": a ground shadow so it
   *  looks grounded rather than painted onto the grass, a two-tone leaf
   *  highlight so it reads as one bigger shaded object rather than a flat
   *  fill, a darker/thicker outline, and berries big enough (with their own
   *  outline) to not disappear into the ambient flower speckle. */
  private redrawBush(bush: BerryBush): void {
    const g = bush.sprite;
    g.clear();
    // Soft ground shadow — separates the bush from the turf underneath it.
    g.ellipse(0, 0, 8, 3).fill({ color: 0x000000, alpha: 0.22 });
    // Base foliage, slightly bigger than the original.
    g.ellipse(0, -6, 10, 8).fill({ color: 0x3a6b2a });
    g.ellipse(0, -6, 10, 8).stroke({ width: 1.5, color: 0x14260f });
    // Lighter leaf highlight — reads as one shaded object, not a flat blob,
    // and is the main thing that keeps it from flattening into the tileset.
    g.ellipse(-3, -9, 5, 4).fill({ color: 0x5c9c46, alpha: 0.9 });
    g.alpha = bush.berries > 0 ? 1 : 0.55;
    // Berries: small red dots, one per remaining berry — outlined so they
    // don't merge with the map's own red-flower ground clutter nearby.
    const dots: [number, number][] = [
      [-4, -9],
      [4, -8],
      [0, -4]
    ];
    for (let i = 0; i < bush.berries; i++) {
      const [dx, dy] = dots[i];
      g.circle(dx, dy, 2.3).fill({ color: 0xe0403a });
      g.circle(dx, dy, 2.3).stroke({ width: 0.6, color: 0x14260f });
    }
  }

  private setupWell(onOpenSettings: () => void): void {
    const tile = this.map.getSpawnPoint(WELL_SPAWN);
    if (!tile) return;
    const { px, py } = this.tileToWorld(tile);
    const well = new Graphics();
    well.circle(0, -6, 9).fill({ color: 0x9a9a92 });
    well.circle(0, -6, 9).stroke({ width: 2, color: 0x1a1320 });
    well.circle(0, -6, 5).fill({ color: 0x14210f });
    well.rect(-1, -18, 2, 12).fill({ color: 0x6b4a2a }); // rope
    well.x = px;
    well.y = py;
    well.zIndex = py;
    well.eventMode = 'static';
    well.cursor = 'pointer';
    well.hitArea = { contains: (x: number, y: number) => x * x + (y + 6) * (y + 6) <= 12 * 12 };
    well.on('pointertap', onOpenSettings);
    this.pulse(well);
    this.propsLayer.addChild(well);
  }

  private setupSignpost(onOpenSessions: () => void): void {
    const tile = this.map.getSpawnPoint(SIGNPOST_SPAWN);
    if (!tile) return;
    const { px, py } = this.tileToWorld(tile);
    // No new art — the map's own signpost/mailbox tile is already drawn
    // here (see stations.ts). Just an invisible hotspot over it.
    const hot = new Container();
    hot.x = px;
    hot.y = py;
    hot.zIndex = py + 1;
    hot.eventMode = 'static';
    hot.cursor = 'pointer';
    hot.hitArea = { contains: (x: number, y: number) => x >= -10 && x <= 10 && y >= -28 && y <= 4 };
    hot.on('pointertap', onOpenSessions);
    this.propsLayer.addChild(hot);
  }

  /** Very slow alpha breathe, just enough to read as "this thing is alive
   *  and clickable" without violating the UI layer's own "no ambient idle
   *  animation" rule (DESIGN.md §12.2) — that rule is scoped to chrome
   *  panels, not the game layer, where motion communicates.
   *
   *  Dirty-flag rendering (idle-energy pass follow-up, 2026-09-01): this
   *  used to be its own independent `requestAnimationFrame` loop, running
   *  forever — visibility-blind — the instant the well prop was built, with
   *  no way to stop it short of the Graphics itself being destroyed. Now
   *  just registers into `pulses`, stepped by `updatePulses()` from
   *  GardenScene's own game-logic ticker (see that method's own comment). */
  private pulse(g: Graphics): void {
    this.pulses.push({ g, t: Math.random() * Math.PI * 2, lastAlpha255: -1 });
  }

  /** rad/sec matching the old loop's `t += 0.02` per `requestAnimationFrame`
   *  call at an assumed 60fps browser refresh (0.02 * 60) — now driven by
   *  real `dt` instead of a raw per-callback increment, so this reads the
   *  same on a 120Hz ProMotion display as a 60Hz one (the same mismatch the
   *  idle-energy pass's own `Ticker.shared.maxFPS` cap exists to fix
   *  elsewhere in this app). */
  private static readonly PULSE_RATE = 1.2;

  /** Advance every registered "breathe" pulse (currently just the well
   *  hotspot) by `dt` seconds — called every game-logic tick from
   *  GardenScene.tsx, gated there on the same `renderPaused` flag that stops
   *  everything else, which is what actually earns this "stop while the
   *  garden is paused" (the old rAF loop never did). Marks the frame dirty
   *  only when the alpha change is large enough to move an 8-bit colour
   *  channel (1/255) — a change smaller than that renders as the exact same
   *  pixel, so it isn't "actually" a change (renderDirty.ts's own wording);
   *  this also caps how often this one subtle, ambient prop can force a
   *  repaint on its own (a handful of times a second at this rate, not 60),
   *  rather than defeating the whole point of render-on-change for
   *  something this minor. */
  updatePulses(dt: number): void {
    let anyDestroyed = false;
    for (const p of this.pulses) {
      if (p.g.destroyed) {
        anyDestroyed = true;
        continue;
      }
      p.t += GardenCharm.PULSE_RATE * dt;
      const alpha = 0.85 + Math.sin(p.t) * 0.15;
      const alpha255 = Math.round(alpha * 255);
      if (alpha255 !== p.lastAlpha255) {
        p.lastAlpha255 = alpha255;
        p.g.alpha = alpha;
        markDirty();
      }
    }
    if (anyDestroyed) this.pulses = this.pulses.filter((p) => !p.g.destroyed);
  }

  private maybeRegrowBushes(): void {
    for (const bush of this.bushes) {
      if (bush.berries >= MAX_BERRIES) continue;
      if (this.clockS < bush.regrowAt) continue;
      bush.berries += 1;
      bush.regrowAt = this.clockS + REGROW_INTERVAL_S;
      this.redrawBush(bush);
    }
  }

  private randomCooldown(): number {
    return COOLDOWN_MIN_S + Math.random() * (COOLDOWN_MAX_S - COOLDOWN_MIN_S);
  }

  /** Send `walker` off on a berry errand right now — the same steps `tick`'s
   *  own berry roll takes, factored out so `forceBerry` (in-app demo mode)
   *  can trigger one on demand without duplicating the bush-pick/goTo/state
   *  bookkeeping. Returns false (no-op) if every bush is picked bare or the
   *  chosen bush is unreachable. */
  private startBerryErrand(sessionId: string, walker: Walker): boolean {
    const candidates = this.bushes.map((b, i) => ({ b, i })).filter(({ b }) => b.berries > 0);
    if (candidates.length === 0) return false;
    const { b: bush, i: index } = candidates[Math.floor(Math.random() * candidates.length)];
    if (!walker.goTo(bush.tile)) return false; // unreachable this map — skip silently
    let cs = this.charmStates.get(sessionId);
    if (!cs) {
      cs = { cooldownS: this.randomCooldown(), busy: false, bushIndex: null, busyElapsedS: 0 };
      this.charmStates.set(sessionId, cs);
    }
    cs.busy = true;
    cs.bushIndex = index;
    cs.busyElapsedS = 0;
    walker.showText(pickBerryErrandLine());
    walker.lingerBubble();
    return true;
  }

  private progressErrand(walker: Walker, cs: CharmState): void {
    cs.busyElapsedS += 1;
    const bush = cs.bushIndex !== null ? this.bushes[cs.bushIndex] : undefined;
    if (!bush) {
      cs.busy = false;
      return;
    }
    const arrived = walker.tile.x === bush.tile.x && walker.tile.y === bush.tile.y;
    const timedOut = cs.busyElapsedS >= ERRAND_TIMEOUT_S;
    if (!arrived && !timedOut) return;

    cs.busy = false;
    cs.bushIndex = null;
    walker.beginWander();
    if (arrived && bush.berries > 0) {
      bush.berries -= 1;
      this.redrawBush(bush);
      walker.showFloatingText('berry!');
      walker.showText(pickBerryEatenLine());
      walker.lingerBubble();
    }
  }

  /** Called once per second (GardenScene's existing 1Hz flush) with the
   *  current sessions + their live walkers. Everything here is best-effort:
   *  a session that vanished mid-errand (killed) just drops its charm state
   *  along with its walker — nothing to clean up beyond that. */
  tick(sessions: readonly CharmSessionLike[], walkers: ReadonlyMap<string, Walker>): void {
    this.clockS += 1;
    this.maybeRegrowBushes();
    this.lastWalkers = walkers;

    const liveIds = new Set(sessions.map((s) => s.id));
    for (const id of [...this.charmStates.keys()]) if (!liveIds.has(id)) this.charmStates.delete(id);

    for (const session of sessions) {
      const walker = walkers.get(session.id);
      if (!walker) continue;
      let cs = this.charmStates.get(session.id);
      if (!cs) {
        cs = { cooldownS: this.randomCooldown(), busy: false, bushIndex: null, busyElapsedS: 0 };
        this.charmStates.set(session.id, cs);
      }

      if (cs.busy) {
        this.progressErrand(walker, cs);
        continue;
      }

      if (session.status !== 'idle') continue; // only idle wanderers get charm beats

      cs.cooldownS -= 1;
      if (cs.cooldownS > 0) continue;
      cs.cooldownS = this.randomCooldown();

      const roll = Math.random();
      if (roll < BERRY_CHANCE) {
        this.startBerryErrand(session.id, walker);
      } else if (roll < BERRY_CHANCE + CHATTER_CHANCE) {
        walker.showText(pickIdleLine());
        walker.lingerBubble();
      }
    }
  }

  /** In-app demo mode (`demo.ts`'s `smallTalk` trigger, via `charmBus.ts`) —
   *  show an idle speech bubble for `sessionId` right now, bypassing the
   *  normal cooldown/status gating `tick()`'s own roll applies. No-op if the
   *  session has no live walker (torn down, or genuinely unknown). */
  forceChatter(sessionId: string): void {
    const walker = this.lastWalkers.get(sessionId);
    if (!walker) return;
    walker.showText(pickIdleLine());
    walker.lingerBubble();
  }

  /** In-app demo mode (`demo.ts`'s `berry` trigger, via `charmBus.ts`) — send
   *  `sessionId`'s walker on a berry errand right now, same bypass as
   *  `forceChatter` above. No-op if there's no live walker, every bush is
   *  bare, or the nearest one isn't reachable. */
  forceBerry(sessionId: string): void {
    const walker = this.lastWalkers.get(sessionId);
    if (!walker) return;
    this.startBerryErrand(sessionId, walker);
  }

  destroy(): void {
    this.propsLayer.destroy({ children: true });
  }
}
