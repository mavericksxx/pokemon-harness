import { useEffect, useRef } from 'react';
import { Application, Container } from 'pixi.js';
// Pixi 8 compiles shader/uniform code with `new Function` by default, which the
// renderer's CSP (no 'unsafe-eval') forbids. This is Pixi's own supported
// no-eval path; it must be imported before an Application is created.
import 'pixi.js/unsafe-eval';
import { TiledMapRenderer, type TiledMap } from './TiledMapRenderer';
import { Camera } from './Camera';
import { SeatPool } from './SeatPool';
import { Walker } from './Walker';
import { loadGardenTilesets } from './gardenArt';
import { loadPokemonAnimations, type PokemonAnimation } from './showdownArt';
import { AIR_ONLY_SPAWNS, BLOCKED_STATION, ENTRANCE_SPAWN, STATION_SPAWNS } from './stations';
import { loadLazyAnimation, placeholderAnimation } from './lazySprites';
import { evolutionConfig, initEvolutionConfig } from './evolution';
import { initShinyConfig } from './shiny';
import { randomAnimatedSpecies, speciesEntry } from './dexData';
import { BattleManager } from './battle/BattleManager';
import { clearBattleFx, spawnShinySparkle } from './battle/battleFx';
import { playSpawnCry } from '@/audio/audioEngine';
// The map keeps its Tiled `.tmj` extension so a real Tiled export can be dropped
// in verbatim; Vite has no JSON loader for that extension, hence `?raw` + parse.
import gardenMapRaw from './maps/garden.tmj?raw';
import { useStore, type Session } from '@/store/store';
import type { StationKind } from '@shared/types';

const gardenMap = JSON.parse(gardenMapRaw) as TiledMap;

/** Per-session bookkeeping the scene keeps outside the store. */
interface Runtime {
  walker: Walker;
  /** The patch station this session claimed for its file work. */
  homePatch: string;
  /** This session's index into EVERY station list. Taken from the patch it
   *  reserved (SeatPool already keeps those distinct), so two concurrent
   *  sessions running Bash go to different logs instead of stacking on one. */
  slot: number;
  /** Last (station, tool, target) applied, so we don't restart the path every frame. */
  lastStation: StationKind | null;
  lastToolKey: string;
  /** Mirrors session.status, refreshed each reconcile — the ticker's 1Hz
   *  work-time accumulator reads this instead of hitting the store per frame. */
  status: Session['status'];
  /** Working-ms accumulated since the last flush into the store. */
  workAccumMs: number;
  /** Set the instant a threshold crossing is noticed, cleared once evolve()
   *  has actually been called (or abandoned) — guards against re-deciding to
   *  evolve on every 1Hz tick while the next stage's art is still loading. */
  evolvePending: boolean;
}

export function GardenScene(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let destroyed = false;
    let cleanup: (() => void) | null = null;

    const init = async (): Promise<void> => {
      await app.init({
        background: 0x16240f,
        // Pixel-art rendering settings, matching the upstream app's floor.
        antialias: false,
        roundPixels: true,
        resolution: Math.max(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        width: host.clientWidth || 800,
        height: host.clientHeight || 600
      });
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      host.appendChild(app.canvas);

      // Both art sets are loaded before the store subscription is wired: a
      // session can appear the instant it is, and addWalker must stay sync.
      // The evolution config (env override, if any) is read once here too, so
      // every threshold check afterward is against its final value.
      const [tilesets, pokemonAnimations] = await Promise.all([
        loadGardenTilesets(),
        loadPokemonAnimations(),
        initEvolutionConfig(),
        initShinyConfig()
      ]);
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }

      const world = new Container();
      app.stage.addChild(world);

      const map = new TiledMapRenderer(gardenMap, tilesets);
      world.addChild(map.getContainer());
      const charLayer = map.getCharacterContainer();
      // Evolution ceremony layers, in the same (map) coordinate space as
      // charLayer and stacked above it, in this order: evolutionDimLayer
      // holds each in-flight ceremony's dim (black) rect, so every OTHER
      // walker in charLayer reads as dimmed beneath it; evolutionFlashLayer,
      // above that, holds each ceremony's flash (white) rect — kept separate
      // and always on top of every dim so one ceremony's flash-out can never
      // be visually crushed by another's still-active dim (see
      // EvolutionCeremony.ts); evolutionCeremonyLayer, above both, is where a
      // ceremony reparents its own walker for the duration, so it stays lit.
      const evolutionDimLayer = new Container();
      const evolutionFlashLayer = new Container();
      const evolutionCeremonyLayer = new Container();
      world.addChild(evolutionDimLayer, evolutionFlashLayer, evolutionCeremonyLayer);
      console.log(
        `[garden] map ${map.width}x${map.height} tiles, ${map.tileSpriteCount} tile sprites, ` +
          `${map.getAllSpawnPoints().size} spawn points, ${map.getAllZones().size} zones`
      );

      const camera = new Camera(world);
      camera.setMapSize(map.width * map.tileSize, map.height * map.tileSize);
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      const patchPool = new SeatPool(STATION_SPAWNS.patch);
      const runtimes = new Map<string, Runtime>();

      const entrance = map.getSpawnPoint(ENTRANCE_SPAWN) ?? { x: 2, y: 2 };

      const spawnTileFor = (
        station: StationKind,
        slot: number,
        canFly: boolean
      ): { x: number; y: number } => {
        // A walking Pokemon is never sent somewhere only wings can reach; it
        // would just stand still, because findPath returns null and goTo fails.
        const names = canFly
          ? STATION_SPAWNS[station]
          : STATION_SPAWNS[station].filter((n) => !AIR_ONLY_SPAWNS.has(n));
        if (names.length === 0) return entrance;
        return map.getSpawnPoint(names[slot % names.length]) ?? entrance;
      };

      /** Bundled species resolve to art already in memory; anything else
       *  starts as a pokeball and is upgraded in place once the lazy fetch
       *  resolves (or stays a pokeball, with a toast, if it can't). Bundled
       *  sheets are never shiny (Phase 5 §2 — there are no local shiny
       *  sheets), so a shiny pick skips the bundled map entirely and always
       *  starts as a pokeball awaiting the lazy shiny fetch, even for one of
       *  the 42 bundled species. */
      const resolveAnimation = (name: string, shiny = false): PokemonAnimation => {
        if (!shiny) {
          const bundled = pokemonAnimations.get(name);
          if (bundled) return bundled;
        }
        return placeholderAnimation(name);
      };

      // Phase 4 Part B — subagent battles. Instantiated here (not module-level)
      // because it needs this scene's own map/charLayer/animation resolvers,
      // and torn down with everything else in cleanup().
      const battleManager = new BattleManager({
        map,
        charLayer,
        resolveAnimation,
        loadLazyAnimation,
        getRuntime: (parentId) => runtimes.get(parentId),
        getParentLabel: (parentId) => {
          const s = useStore.getState().sessions.find((x) => x.id === parentId);
          return s ? (speciesEntry(s.pokemon)?.name ?? s.pokemon) : 'The trainer';
        },
        getParentSpeciesId: (parentId) => useStore.getState().sessions.find((x) => x.id === parentId)?.pokemon,
        activeSessionLines: () => useStore.getState().takenLines(),
        onBattleEnd: (parentId) => {
          const rt = runtimes.get(parentId);
          if (!rt) return;
          rt.lastStation = null;
          rt.walker.beginWander();
        }
      });

      /** Bundled + not-shiny needs no fetch at all; everything else (any
       *  lazy species, OR a shiny pick even of a bundled species — Phase 5
       *  §2) resolves in place once loadLazyAnimation returns. A shiny
       *  session's reveal sparkle + "✨ Shiny!" text fires here, at the
       *  moment its REAL sprite lands — not at addWalker time, when it's
       *  still a pokeball placeholder — so the screenshot-worthy reveal
       *  shows the actual shiny palette. Fires even if the fetch failed
       *  (still a pokeball): the flag, and therefore the reveal, doesn't
       *  depend on the sprite actually loading. */
      const upgradeIfLazy = (session: Session, walker: Walker, rt: Runtime): void => {
        if (!session.shiny && pokemonAnimations.has(session.pokemon)) return;
        void loadLazyAnimation(session.pokemon, session.shiny).then((anim) => {
          if (runtimes.get(session.id) !== rt) return; // session gone/replaced meanwhile
          if (anim) {
            walker.setAnimation(anim);
          } else {
            const label = speciesEntry(session.pokemon)?.name ?? session.pokemon;
            useStore.getState().pushToast(`Couldn't load ${label}'s sprite — offline or not found.`);
          }
          if (session.shiny) {
            spawnShinySparkle(walker.container, -walker.spriteHeight - 8);
            walker.showFloatingText('✨ Shiny!');
          }
        });
      };

      const addWalker = (session: Session): Runtime => {
        const homePatch = patchPool.reserveNext() ?? STATION_SPAWNS.patch[0];
        const slot = Math.max(0, STATION_SPAWNS.patch.indexOf(homePatch));
        const animation = resolveAnimation(session.pokemon, session.shiny);
        const walker = new Walker({
          sessionId: session.id,
          map,
          animation,
          startTile: entrance,
          // Wander around the claimed patch, not the shared gate.
          homeTile: map.getSpawnPoint(homePatch) ?? entrance,
          accentColor: session.accent,
          label: session.title,
          dimLayer: evolutionDimLayer,
          flashLayer: evolutionFlashLayer,
          ceremonyLayer: evolutionCeremonyLayer,
          onClick: (id) => useStore.getState().select(id)
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
          workAccumMs: 0,
          evolvePending: false
        };
        runtimes.set(session.id, rt);
        upgradeIfLazy(session, walker, rt);
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
        const bundled = session.shiny ? undefined : pokemonAnimations.get(nextId);

        const proceed = (anim: PokemonAnimation, failed: boolean): void => {
          rt.evolvePending = false;
          if (runtimes.get(session.id) !== rt) return; // session gone meanwhile
          if (failed) {
            const label = speciesEntry(nextId)?.name ?? nextId;
            useStore.getState().pushToast(`Couldn't load ${label}'s sprite — evolving with a placeholder.`);
          }
          const nextLabel = speciesEntry(nextId)?.name ?? nextId;
          rt.walker.evolve(anim, entry.name, nextLabel, nextId, () => {
            useStore.getState().updateSession(session.id, { pokemon: nextId });
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

      const removeWalker = (id: string): void => {
        const rt = runtimes.get(id);
        if (!rt) return;
        battleManager.forceEnd(id);
        patchPool.release(rt.homePatch);
        rt.walker.destroy();
        runtimes.delete(id);
      };

      /** Reconcile walkers with the session list — the single place the store
       *  drives the garden. */
      const applyState = (): void => {
        const { sessions, selectedId } = useStore.getState();
        const live = new Set(sessions.map((s) => s.id));
        for (const id of [...runtimes.keys()]) if (!live.has(id)) removeWalker(id);

        for (const session of sessions) {
          const rt = runtimes.get(session.id) ?? addWalker(session);
          const { walker } = rt;
          rt.status = session.status;
          walker.setSelected(session.id === selectedId);
          walker.setLabel(session.title);
          walker.setStatus(session.status);

          // A battling parent owns its own walker's position/facing for the
          // duration (approach/faceoff/attack loop) — the normal station
          // reconcile stands down until BattleManager hands it back via
          // onBattleEnd, which resets lastStation so this picks up again.
          if (!battleManager.isBattling(session.id)) {
            const station: StationKind =
              session.status === 'blocked'
                ? BLOCKED_STATION
                : session.status === 'working'
                  ? session.station
                  : 'wander';

            if (station !== rt.lastStation) {
              if (station === 'wander') {
                walker.beginWander();
                rt.lastStation = station;
              } else if (walker.goTo(spawnTileFor(station, rt.slot, walker.canFly))) {
                rt.lastStation = station;
              }
              // A failed goTo leaves lastStation alone so the next status change
              // retries rather than assuming the walker is en route.
            }
          }

          const toolKey = `${session.status}|${session.tool ?? ''}|${session.toolTarget ?? ''}`;
          if (toolKey !== rt.lastToolKey) {
            rt.lastToolKey = toolKey;
            if (session.status === 'working' && session.tool) {
              walker.showTool(session.tool, session.toolTarget ?? '');
            } else if (session.status === 'working') {
              walker.showTool('', '...');
            } else if (session.status === 'blocked') {
              walker.showText('needs you');
            } else {
              walker.lingerBubble();
            }
          }
        }
      };

      const unsubscribe = useStore.subscribe(applyState);
      applyState();

      // Evolution's threshold check needs accumulated working-ms, which only
      // needs to be accurate to about a second — flushing every frame would
      // mean a store write (and an applyState reconcile) 60 times a second.
      let flushAccum = 0;

      app.ticker.add((ticker) => {
        const dt = Math.min(ticker.deltaMS / 1000, 0.1);
        map.update(dt * 1000);
        for (const rt of runtimes.values()) {
          rt.walker.update(dt);
          if (rt.status === 'working') rt.workAccumMs += dt * 1000;
        }
        // Runs after every walker's own update() so battle positioning always
        // overwrites with a fresh absolute (base + offset) value rather than
        // fighting Walker's own syncPosition from a stale frame.
        battleManager.update(dt);

        flushAccum += dt;
        if (flushAccum >= 1) {
          flushAccum = 0;
          const cfg = evolutionConfig();
          for (const session of useStore.getState().sessions) {
            const rt = runtimes.get(session.id);
            if (!rt || rt.workAccumMs <= 0) continue;
            const workedMs = session.workedMs + rt.workAccumMs;
            rt.workAccumMs = 0;
            useStore.getState().updateSession(session.id, { workedMs });

            // A battle mid-attack retries next tick — the evolution ceremony
            // waits for the current attack beat to finish, then takes over
            // (it's already exclusive), and the battle resumes after.
            if (rt.evolvePending || rt.walker.isEvolving || battleManager.isMidAttack(session.id)) continue;
            const entry = speciesEntry(session.pokemon);
            if (!entry) continue;
            const crossedStage2 = entry.stage === 1 && workedMs >= cfg.stage2Ms;
            const crossedStage3 = entry.stage === 2 && workedMs >= cfg.stage3Ms;
            if (crossedStage2 || crossedStage3) triggerEvolve(session, rt);
          }
        }

        const selectedId = useStore.getState().selectedId;
        const focus = selectedId ? runtimes.get(selectedId) : undefined;
        if (focus) camera.focusOn(focus.walker.worldX, focus.walker.worldY - 12, 2.4);
        else camera.fitToScreen();
        camera.update();
      });

      const ro = new ResizeObserver(() => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 2 || h < 2) return;
        app.renderer.resize(w, h);
        camera.setViewSize(w, h);
      });
      ro.observe(host);

      cleanup = (): void => {
        ro.disconnect();
        unsubscribe();
        for (const id of [...runtimes.keys()]) removeWalker(id);
        battleManager.dispose();
        clearBattleFx();
        app.destroy(true, { children: true });
      };
    };

    void init();

    return () => {
      destroyed = true;
      cleanup?.();
    };
  }, []);

  return <div className="garden" ref={hostRef} />;
}
