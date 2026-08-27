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
import { loadPokemonAnimations, POKEMON_ROSTER } from './showdownArt';
import { AIR_ONLY_SPAWNS, BLOCKED_STATION, ENTRANCE_SPAWN, STATION_SPAWNS } from './stations';
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
  /** Whether this session's Pokemon may be sent to an air-only station. */
  canFly: boolean;
  /** Last (station, tool, target) applied, so we don't restart the path every frame. */
  lastStation: StationKind | null;
  lastToolKey: string;
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
      const [tilesets, pokemonAnimations] = await Promise.all([
        loadGardenTilesets(),
        loadPokemonAnimations()
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

      const addWalker = (session: Session): Runtime => {
        const homePatch = patchPool.reserveNext() ?? STATION_SPAWNS.patch[0];
        const slot = Math.max(0, STATION_SPAWNS.patch.indexOf(homePatch));
        const animation =
          pokemonAnimations.get(session.pokemon) ??
          pokemonAnimations.get(POKEMON_ROSTER[0].name)!;
        const walker = new Walker({
          sessionId: session.id,
          map,
          animation,
          startTile: entrance,
          // Wander around the claimed patch, not the shared gate.
          homeTile: map.getSpawnPoint(homePatch) ?? entrance,
          accentColor: session.accent,
          label: session.title,
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
          canFly: animation.info.locomotion !== 'walk',
          lastStation: null,
          lastToolKey: ''
        };
        runtimes.set(session.id, rt);
        return rt;
      };

      const removeWalker = (id: string): void => {
        const rt = runtimes.get(id);
        if (!rt) return;
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
          walker.setSelected(session.id === selectedId);
          walker.setLabel(session.title);
          walker.setStatus(session.status);

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
            } else if (walker.goTo(spawnTileFor(station, rt.slot, rt.canFly))) {
              rt.lastStation = station;
            }
            // A failed goTo leaves lastStation alone so the next status change
            // retries rather than assuming the walker is en route.
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

      app.ticker.add((ticker) => {
        const dt = Math.min(ticker.deltaMS / 1000, 0.1);
        map.update(dt * 1000);
        for (const rt of runtimes.values()) rt.walker.update(dt);

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
