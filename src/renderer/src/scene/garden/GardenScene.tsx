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
import { buildTilesetTexture, buildWalkerSheet } from './placeholderArt';
import { BLOCKED_STATION, ENTRANCE_SPAWN, STATION_SPAWNS } from './stations';
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

      const tileset = buildTilesetTexture();
      const world = new Container();
      app.stage.addChild(world);

      const map = new TiledMapRenderer(gardenMap, [tileset]);
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

      const spawnTileFor = (station: StationKind, homePatch: string): { x: number; y: number } => {
        if (station === 'patch') return map.getSpawnPoint(homePatch) ?? entrance;
        const name = STATION_SPAWNS[station][0];
        return (name ? map.getSpawnPoint(name) : undefined) ?? entrance;
      };

      const addWalker = (session: Session): Runtime => {
        const homePatch = patchPool.reserveNext() ?? STATION_SPAWNS.patch[0];
        const frames = buildWalkerSheet('#ffffff', '#e2e2e2');
        const walker = new Walker({
          sessionId: session.id,
          map,
          frames,
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
        const rt: Runtime = { walker, homePatch, lastStation: null, lastToolKey: '' };
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
            } else if (walker.goTo(spawnTileFor(station, rt.homePatch))) {
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
