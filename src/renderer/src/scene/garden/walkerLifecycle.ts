import type { Container } from 'pixi.js';
import type { TiledMapRenderer, Point } from './TiledMapRenderer';
import { Walker } from './Walker';
import { SeatPool } from './SeatPool';
import { STATION_SPAWNS } from './stations';
import { loadLazyAnimation, placeholderAnimation } from './lazySprites';
import { randomAnimatedSpecies, speciesEntry } from './dexData';
import type { PokemonAnimation } from './showdownArt';
import type { BattleManager } from './battle/BattleManager';
import { spawnShinySparkle, spawnSparkleBurst } from './battle/battleFx';
import { playSpawnCry } from '@/audio/audioEngine';
import type { Session } from '@/store/store';
import type { StationKind } from '@shared/types';
import { markDirty } from './renderDirty';

/** Per-session bookkeeping the scene keeps outside the store. */
export interface Runtime {
  walker: Walker;
  /** The patch station this session claimed for its file work, or null when
   *  every one of the 6 seats was already taken at spawn time (overflow) —
   *  null must NOT be released back to the pool, since it was never reserved. */
  homePatch: string | null;
  /** This session's index into EVERY station list. Taken from the patch it
   *  reserved (SeatPool already keeps those distinct), so two concurrent
   *  sessions running Bash go to different logs instead of stacking on one.
   *  An overflow session (no patch reservation) gets a distinct index from
   *  `overflowSlot` instead, so it doesn't collide with every other overflow
   *  session on the same wander spot. */
  slot: number;
  /** Last (station, tool, target) applied, so we don't restart the path every frame. */
  lastStation: StationKind | null;
  lastToolKey: string;
  /** Mirrors session.status, refreshed each reconcile — the ticker's 1Hz
   *  work-time accumulator reads this instead of hitting the store per frame. */
  status: Session['status'];
  /** The status this walker's session had on the PREVIOUS reconcile — the
   *  edge detector for delegate battle parity (a delegate finishing is a
   *  one-shot transition INTO 'done', but `applyState` re-runs on every store
   *  change while it sits there). Same `rt.lastX`-diffed-each-pass convention
   *  as `lastStation`/`lastToolKey`/`appliedPokemonId` above; seeded from the
   *  session's CURRENT status at walker creation, like `appliedPokemonId`, so
   *  a walker born into a state never reads as having just transitioned into
   *  it. Distinct from `status` above, which is refreshed for the ticker's
   *  own use and so can't double as a previous-value memory. */
  lastStatus: Session['status'];
  /** Working-ms accumulated since the last flush into the store. */
  workAccumMs: number;
  /** Set the instant a threshold crossing is noticed, cleared once evolve()
   *  has actually been called (or abandoned) — guards against re-deciding to
   *  evolve on every 1Hz tick while the next stage's art is still loading. */
  evolvePending: boolean;
  /** The species id currently reflected in this walker's sprite. Kept in
   *  sync with `session.pokemon` by triggerEvolve's own ceremony swap AND by
   *  applyManualSwap (the roster card's "change pokemon" action) — the
   *  latter diffs against THIS, not `session.pokemon` read fresh, so a swap
   *  is applied exactly once even though `session.pokemon` itself doesn't
   *  change again until the next swap or evolution. */
  appliedPokemonId: string;
}

/** Dependencies `createWalkerLifecycle` needs from its owning `mountScene`
 *  generation — mirrors BattleManager/AdvisorManager's own `Deps` object
 *  convention: getters for anything read fresh, callbacks for anything that
 *  writes back into the store/UI, and the mutable/shared objects (`map`,
 *  layers, `runtimes`) passed by reference rather than copied. `runtimes`
 *  itself stays owned by GardenScene.tsx (it's read by far more than just
 *  this lifecycle — applyState, the ticker, gardenInput's click-correction,
 *  battle/advisor deps), so it's passed in, not created here.
 *
 *  `getBattleManager` is a lazy getter rather than a plain `BattleManager`
 *  reference on purpose: BattleManager's own `onBattleEnd` callback needs
 *  `applyManualSwap` (this module's own export) to be defined already, so
 *  this lifecycle is constructed BEFORE `battleManager` in GardenScene.tsx —
 *  the reverse of the getter direction gardenInput.ts needs, but the same
 *  forward-reference-via-closure trick that let the original single-scope
 *  effect body reference either one before the other. */
export interface WalkerLifecycleCtx {
  map: TiledMapRenderer;
  charLayer: Container;
  evolutionDimLayer: Container;
  evolutionFlashLayer: Container;
  evolutionCeremonyLayer: Container;
  runtimes: Map<string, Runtime>;
  /** Snapshot of bundled animations taken at this generation's mount —
   *  mirrors GardenScene's own `pokemonAnimations` local. */
  pokemonAnimations: Map<string, PokemonAnimation>;
  resolveAnimation: (name: string, shiny?: boolean) => PokemonAnimation;
  /** Session ids already live at the moment this generation mounted — used
   *  to tell a restored walker (already home) from a genuinely new one
   *  (still walks in from the entrance). */
  sessionsAtMount: Set<string>;
  entrance: Point;
  spawnTileFor: (station: StationKind, slot: number, canFly: boolean) => Point;
  /** A rebuild's pre-teardown walker-tile snapshot, keyed by session id —
   *  see gardenRebuild.ts's own `pendingWalkerTiles`. */
  getPendingWalkerTile: (sessionId: string) => Point | undefined;
  getBattleManager: () => BattleManager;
  onWalkerClick: (id: string) => void;
  pushToast: (message: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
}

export interface WalkerLifecycle {
  addWalker: (session: Session) => Runtime;
  removeWalker: (id: string) => void;
  applyManualSwap: (session: Session, rt: Runtime) => void;
  triggerEvolve: (session: Session, rt: Runtime) => void;
  upgradeIfLazy: (session: Session, speciesId: string, shiny: boolean, walker: Walker, rt: Runtime) => void;
  snapshotWalkerTiles: () => Map<string, Point>;
}

export function createWalkerLifecycle(ctx: WalkerLifecycleCtx): WalkerLifecycle {
  const { map, charLayer, evolutionDimLayer, evolutionFlashLayer, evolutionCeremonyLayer, runtimes } = ctx;
  const patchPool = new SeatPool(STATION_SPAWNS.patch);
  // Shared counter for every session that couldn't claim one of the 6
  // patch seats (all 6 already taken) — gives each overflow session its
  // own distinct slot instead of every one of them landing on slot 0 and
  // stacking on the same wander tile. Never reset, so overflow sessions
  // across the whole scene lifetime keep spreading out rather than
  // re-colliding once the count wraps past STATION_SPAWNS.wander.length.
  let overflowSlot = 0;

  /** Bundled + not-shiny needs no fetch at all; everything else (any
   *  lazy species, OR a shiny pick even of a bundled species — Phase 5
   *  §2) resolves in place once loadLazyAnimation returns. A shiny
   *  session's reveal sparkle + "Shiny!" text fires here, at the
   *  moment its REAL sprite lands — not at addWalker time, when it's
   *  still a pokeball placeholder — so the screenshot-worthy reveal
   *  shows the actual shiny palette. Fires even if the fetch failed
   *  (still a pokeball): the flag, and therefore the reveal, doesn't
   *  depend on the sprite actually loading. */
  /** `speciesId`/`shiny` are captured explicitly, not read off `session`
   *  inside the `.then` — `session` there would be a stale closed-over
   *  snapshot if the species changed again (another evolve, or a manual
   *  swap) while this fetch was in flight. The `rt.appliedPokemonId`
   *  check below is what actually guards against applying a
   *  now-superseded species' art on top of whatever's current. */
  const upgradeIfLazy = (session: Session, speciesId: string, shiny: boolean, walker: Walker, rt: Runtime): void => {
    if (!shiny && ctx.pokemonAnimations.has(speciesId)) return;
    void loadLazyAnimation(speciesId, shiny).then((anim) => {
      if (runtimes.get(session.id) !== rt) return; // session gone/replaced meanwhile
      if (rt.appliedPokemonId !== speciesId) return; // superseded by a later evolve/swap meanwhile
      if (anim) {
        walker.setAnimation(anim);
      } else {
        const label = speciesEntry(speciesId)?.name ?? speciesId;
        ctx.pushToast(`couldn't load ${label}'s sprite — offline or not found.`);
      }
      if (shiny) {
        spawnShinySparkle(walker.container, -walker.spriteHeight - 8);
        walker.showFloatingText('Shiny!');
      }
    });
  };

  const addWalker = (session: Session): Runtime => {
    const reservedHomePatch = patchPool.reserveNext();
    // No `?? STATION_SPAWNS.patch[0]` fallback here on purpose: forging an
    // overflow session onto slot 0's tile without actually reserving it
    // is exactly the double-booking bug this fixes (see `homePatch`'s own
    // comment on Runtime and `removeWalker` below).
    const homePatch = reservedHomePatch;
    const slot = reservedHomePatch ? STATION_SPAWNS.patch.indexOf(reservedHomePatch) : overflowSlot++;
    const animation = ctx.resolveAnimation(session.pokemon, session.shiny);
    const restored = ctx.sessionsAtMount.has(session.id);
    const restoredTile = ctx.getPendingWalkerTile(session.id);
    // Restored idle walkers are already home; live sessions still walk in from the entrance.
    const startTile =
      restoredTile ??
      (restored && session.status !== 'working'
        ? reservedHomePatch
          ? ctx.spawnTileFor('patch', slot, animation.info.locomotion !== 'walk')
          : ctx.spawnTileFor('wander', slot, animation.info.locomotion !== 'walk')
        : ctx.entrance);
    const walker = new Walker({
      sessionId: session.id,
      map,
      animation,
      startTile,
      accentColor: session.accent,
      label: session.title,
      dimLayer: evolutionDimLayer,
      flashLayer: evolutionFlashLayer,
      ceremonyLayer: evolutionCeremonyLayer,
      onClick: (id) => ctx.onWalkerClick(id)
    });
    charLayer.addChild(walker.container);
    charLayer.addChild(walker.bubbleContainer);
    walker.showText(session.title);
    walker.lingerBubble();
    const rt: Runtime = {
      walker,
      homePatch,
      slot,
      lastStation: null,
      lastToolKey: '',
      status: session.status,
      lastStatus: session.status,
      workAccumMs: 0,
      evolvePending: false,
      appliedPokemonId: session.pokemon
    };
    runtimes.set(session.id, rt);
    upgradeIfLazy(session, session.pokemon, session.shiny, walker, rt);
    playSpawnCry(session.pokemon); // this session's walker's first spawn (Phase 7)
    return rt;
  };

  /** Evolve `session`'s walker to a random member of its current
   *  species' evolvesTo, loading that species' art first (bundled: instant;
   *  lazy: fetched, falling back to a pokeball + toast on failure).
   *  Static (Gen 6-9) targets are excluded from the random draw (Phase 6
   *  §4) — if every branch is static, the species just doesn't evolve
   *  further here; it's still reachable by picking it directly. */
  const triggerEvolve = (session: Session, rt: Runtime): void => {
    const entry = speciesEntry(session.pokemon);
    if (!entry || entry.evolvesTo.length === 0) return;
    const nextId = randomAnimatedSpecies(entry.evolvesTo);
    if (!nextId) return;
    rt.evolvePending = true;
    // Shiny stays shiny through evolution (Phase 5 §5): bundled sheets
    // are never shiny, so a shiny session's next stage always goes
    // through the lazy fetch too, exactly like resolveAnimation above.
    const bundled = session.shiny ? undefined : ctx.pokemonAnimations.get(nextId);

    const proceed = (anim: PokemonAnimation, failed: boolean): void => {
      rt.evolvePending = false;
      if (runtimes.get(session.id) !== rt) return; // session gone meanwhile
      if (failed) {
        const label = speciesEntry(nextId)?.name ?? nextId;
        ctx.pushToast(`couldn't load ${label}'s sprite — evolving with a placeholder.`);
      }
      const nextLabel = speciesEntry(nextId)?.name ?? nextId;
      rt.walker.evolve(anim, entry.name, nextLabel, nextId, () => {
        rt.appliedPokemonId = nextId;
        ctx.updateSession(session.id, { pokemon: nextId });
      });
    };

    if (bundled) {
      proceed(bundled, false);
    } else {
      void loadLazyAnimation(nextId, session.shiny).then((anim) => {
        proceed(anim ?? placeholderAnimation(nextId), !anim);
      });
    }
  };

  /** Roster card's "change pokemon" action (sessions.ts's
   *  `swapSessionPokemon` already updated `session.pokemon`/`.line` in
   *  the store) — brings the walker's SPRITE in line: an instant swap
   *  (setAnimation, no flash/ceremony — the store's `pokemon` already
   *  accounts for earned stage, so evolution's own 1Hz threshold check
   *  won't fire a ceremony for it), a poof, and the new species' cry.
   *  Skipped while a ceremony or a battle owns this session's walker;
   *  the caller retries on the next reconcile (applyState fires on
   *  every store change, and onBattleEnd calls this directly the moment
   *  a deferred swap becomes safe). */
  const applyManualSwap = (session: Session, rt: Runtime): void => {
    if (rt.appliedPokemonId === session.pokemon) return;
    if (rt.walker.isEvolving || ctx.getBattleManager().isBattling(session.id)) return;
    rt.appliedPokemonId = session.pokemon;
    rt.walker.setAnimation(ctx.resolveAnimation(session.pokemon, session.shiny));
    spawnSparkleBurst(rt.walker.container);
    playSpawnCry(session.pokemon);
    upgradeIfLazy(session, session.pokemon, session.shiny, rt.walker, rt);
  };

  const removeWalker = (id: string): void => {
    const rt = runtimes.get(id);
    if (!rt) return;
    // Delegate battle parity — FIRST, before anything below destroys the
    // walker: if this session is a delegate currently entered as a
    // challenger, BattleManager is holding a `WalkerChallenger` over the
    // very walker this function is about to destroy. Dropping it here
    // force-concludes any wave it was mid-way through (freeing the global
    // battle lock and releasing the parent's stance/mega) instead of
    // leaving a sub choreographing a destroyed sprite. A no-op for every
    // ordinary session. `forceEnd` below is the mirror for this session's
    // own role as a PARENT and can't cover this: it's keyed by parent id.
    const battleManager = ctx.getBattleManager();
    battleManager.dropChallenger(id);
    battleManager.forceEnd(id);
    // Only release a seat this session actually reserved — an overflow
    // session's `homePatch` is null (see Runtime's own comment), and
    // releasing patch[0] on its behalf would free a seat a different,
    // still-live session legitimately owns.
    if (rt.homePatch) patchPool.release(rt.homePatch);
    rt.walker.destroy();
    runtimes.delete(id);
    markDirty(); // a walker disappearing is a visible change with no other hook covering it
  };

  const snapshotWalkerTiles = (): Map<string, Point> =>
    new Map([...runtimes].map(([id, runtime]) => [id, runtime.walker.tile]));

  return { addWalker, removeWalker, applyManualSwap, triggerEvolve, upgradeIfLazy, snapshotWalkerTiles };
}
