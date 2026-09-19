/**
 * Headless garden for the landing-page showreel.
 *
 * Assembles the desktop app's REAL scene modules the same way
 * src/renderer/src/scene/garden/GardenScene.tsx's `mountScene` does —
 * Application -> TiledMapRenderer (+ border) -> evolution layers -> Camera ->
 * DayNightOverlay -> walkerLifecycle -> BattleManager — minus everything
 * that needs the app's zustand stores, IPC, or user input (GardenScene.tsx
 * itself is never imported). The session list lives in a plain Map here and
 * `reconcile()` is a trimmed copy of GardenScene's `applyState` loop.
 *
 * Nothing here re-implements an animation: walking, tool bubbles, spawns,
 * battles, evolution, mega and shiny reveals are all the app's own code.
 */
import { Application, Container, Ticker } from 'pixi.js';
import { TiledMapRenderer, type TiledMap, type Point } from '@/scene/garden/TiledMapRenderer';
import { buildMapBorder, DEFAULT_GARDEN_BORDER } from '@/scene/garden/mapBorder';
import { DayNightOverlay } from '@/scene/garden/DayNightOverlay';
import { Camera } from '@/scene/garden/Camera';
import { loadGardenTilesets } from '@/scene/garden/gardenArt';
import { loadPokemonAnimations, type PokemonAnimation } from '@/scene/garden/showdownArt';
import { AIR_ONLY_SPAWNS, ENTRANCE_SPAWN, STATION_SPAWNS } from '@/scene/garden/stations';
import { WanderReservations } from '@/scene/garden/wanderReservations';
import { loadLazyAnimation, placeholderAnimation } from '@/scene/garden/lazySprites';
import { initEvolutionConfig } from '@/scene/garden/evolution';
import { initShinyConfig } from '@/scene/garden/shiny';
import { speciesEntry } from '@/scene/garden/dexData';
import { BattleManager } from '@/scene/garden/battle/BattleManager';
import { clearBattleFx } from '@/scene/garden/battle/battleFx';
import { GardenCharm } from '@/scene/garden/gardenCharm';
import { createWalkerLifecycle, type Runtime, type WalkerLifecycle } from '@/scene/garden/walkerLifecycle';
import { formatBubbleLabel } from '@/design/toolTargetLabel';
import type { Session } from '@/store/store';
import type { StationKind, SessionStatus } from '@shared/types';
import gardenMapRaw from '@/scene/garden/maps/garden.tmj?raw';

const gardenMap = JSON.parse(gardenMapRaw) as TiledMap;

/** The handful of `Session` fields the garden modules actually read. */
export interface ReelSession {
  id: string;
  title: string;
  pokemon: string;
  shiny: boolean;
  status: SessionStatus;
  accent: number;
  tool?: string;
  toolTarget?: string;
}

/** What the camera follows each frame. */
export type CameraSubject =
  | { kind: 'fit' }
  | { kind: 'wide' }
  | { kind: 'walker'; id: string; zoom?: number }
  | { kind: 'battle'; parentId: string; key: string; zoom?: number };

export interface ReelGarden {
  readonly host: HTMLElement;
  readonly battles: BattleManager;
  sessions: Map<string, ReelSession>;
  runtime(id: string): Runtime | undefined;
  /** Dev-only framing probe: the camera subject's screen positions vs the pane. */
  debugFraming(): { kind: string; width: number; height: number; points: { x: number; y: number }[] };
  upsert(session: ReelSession): void;
  patch(id: string, patch: Partial<ReelSession>): void;
  remove(id: string): void;
  evolve(id: string): void;
  /** Species lines a wild battler must NOT be drawn from (BattleDeps). */
  setExcludedLines(lines: string[]): void;
  setCamera(subject: CameraSubject): void;
  /** Jump the camera straight to its current subject on the next tick
   *  instead of easing there (the reel's opening frame). */
  snapCamera(): void;
  setNight(hour: number | 'day'): void;
  setBackground(color: number): void;
  /** Called every rendered tick with the (clamped) frame delta in ms. */
  onTick(cb: (dtMs: number) => void): void;
  setPaused(paused: boolean): void;
  /** Tear down every walker/battler and start from an empty garden again. */
  reset(): void;
  destroy(): void;
}

const HOUR_OVERRIDE_KEY = 'poke:daynightHourOverride';

export async function mountShowreel(host: HTMLElement, background: number): Promise<ReelGarden> {
  const app = new Application();
  await app.init({
    background,
    antialias: false,
    roundPixels: true,
    resolution: Math.min(Math.max(window.devicePixelRatio || 1, 1), 2),
    autoDensity: true,
    width: host.clientWidth || 800,
    height: host.clientHeight || 560
  });
  app.ticker.maxFPS = 60;
  Ticker.shared.maxFPS = 60;
  app.canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(app.canvas);

  const [tilesets, pokemonAnimations] = await Promise.all([
    loadGardenTilesets(),
    loadPokemonAnimations(),
    initEvolutionConfig(),
    initShinyConfig()
  ]);

  const world = new Container();
  app.stage.addChild(world);
  const map = new TiledMapRenderer(gardenMap, tilesets);
  world.addChild(buildMapBorder(gardenMap, tilesets, DEFAULT_GARDEN_BORDER));
  const borderPx = DEFAULT_GARDEN_BORDER.thickness * map.tileSize;
  const content = new Container();
  content.position.set(borderPx, borderPx);
  world.addChild(content);
  content.addChild(map.getContainer());
  const charLayer = map.getCharacterContainer();
  const evolutionDimLayer = new Container();
  const evolutionFlashLayer = new Container();
  const evolutionCeremonyLayer = new Container();
  content.addChild(evolutionDimLayer, evolutionFlashLayer, evolutionCeremonyLayer);

  const camera = new Camera(world);
  const mapWidthPx = (map.width + DEFAULT_GARDEN_BORDER.thickness * 2) * map.tileSize;
  const mapHeightPx = (map.height + DEFAULT_GARDEN_BORDER.thickness * 2) * map.tileSize;
  camera.setMapSize(mapWidthPx, mapHeightPx);

  // Same construction as GardenScene.tsx (pond-anchored moon pool, the
  // user-approved gate-lamp position, canopy tint hook).
  const pond = map.getZone('pond');
  const dayNight = new DayNightOverlay({
    widthPx: mapWidthPx,
    heightPx: mapHeightPx,
    poolCenter: pond
      ? {
          x: (pond.x + pond.width / 2) * map.tileSize + borderPx,
          y: (pond.y + pond.height / 2) * map.tileSize + borderPx
        }
      : { x: mapWidthPx * 0.73, y: mapHeightPx * 0.39 },
    gateLampCenter: { x: mapWidthPx * 0.4531, y: mapHeightPx * 0.3611 },
    staticTiles: map.getContainer(),
    liveLayer: charLayer,
    staticTilesWidthPx: map.width * map.tileSize,
    staticTilesHeightPx: map.height * map.tileSize,
    staticTilesOffsetPx: { x: borderPx, y: borderPx },
    content,
    applyCanopyNightTint: (tintForY) => map.setNightTint(tintForY)
  });
  dayNight.mount(app.renderer, world);
  dayNight.setModeOverride('day');

  // Props only (berry bushes, well) — its idle errands are never ticked, so
  // it can't walk a walker away from the shot the reel is framing.
  const gardenCharm = new GardenCharm({ map, layer: charLayer, onOpenSessions: () => {}, onOpenSettings: () => {} });

  const syncSize = (): void => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) return;
    app.renderer.resize(w, h);
    camera.setViewSize(w, h);
  };
  syncSize();
  const ro = new ResizeObserver(syncSize);
  ro.observe(host);

  const entrance = map.getSpawnPoint(ENTRANCE_SPAWN) ?? { x: 2, y: 2 };
  const spawnTileFor = (station: StationKind, slot: number, canFly: boolean): Point => {
    const names = canFly ? STATION_SPAWNS[station] : STATION_SPAWNS[station].filter((n) => !AIR_ONLY_SPAWNS.has(n));
    if (names.length === 0) return entrance;
    return map.getSpawnPoint(names[slot % names.length]) ?? entrance;
  };
  const resolveAnimation = (name: string, shiny = false): PokemonAnimation => {
    if (!shiny) {
      const bundled = pokemonAnimations.get(name);
      if (bundled) return bundled;
    }
    return placeholderAnimation(name);
  };

  const sessions = new Map<string, ReelSession>();
  let excludedLines: string[] = [];
  let runtimes = new Map<string, Runtime>();
  let lifecycle: WalkerLifecycle;
  let battles: BattleManager;
  const lastTool = new Map<string, string>();

  const asSession = (s: ReelSession): Session => s as unknown as Session;

  /** One cast generation — rebuilt by reset() so every loop starts clean
   *  (fresh seat pool, fresh battle queue/cooldown state). */
  const buildCast = (): void => {
    runtimes = new Map();
    const reservations = new WanderReservations();
    lifecycle = createWalkerLifecycle({
      map,
      charLayer,
      evolutionDimLayer,
      evolutionFlashLayer,
      evolutionCeremonyLayer,
      runtimes,
      reservations,
      pokemonAnimations,
      resolveAnimation,
      sessionsAtMount: new Set(),
      entrance,
      spawnTileFor,
      getPendingWalkerTile: () => undefined,
      getBattleManager: () => battles,
      onWalkerClick: () => {},
      pushToast: () => {},
      updateSession: (id, p) => {
        const s = sessions.get(id);
        if (s && typeof p.pokemon === 'string') s.pokemon = p.pokemon;
      }
    });
    battles = new BattleManager({
      map,
      charLayer,
      resolveAnimation,
      loadLazyAnimation,
      getRuntime: (parentId) => runtimes.get(parentId),
      getParentLabel: (parentId) => {
        const s = sessions.get(parentId);
        return s ? (speciesEntry(s.pokemon)?.name ?? s.pokemon) : 'The trainer';
      },
      getParentSpeciesId: (parentId) => sessions.get(parentId)?.pokemon,
      getParentShiny: (parentId) => sessions.get(parentId)?.shiny ?? false,
      activeSessionLines: () => [
        ...excludedLines,
        ...[...sessions.values()].map((s) => speciesEntry(s.pokemon)?.line ?? s.pokemon)
      ],
      onBattleEnd: (parentId) => {
        const rt = runtimes.get(parentId);
        if (!rt) return;
        rt.lastStation = null;
        rt.walker.setBusy(false);
        rt.walker.beginWander();
      },
      onBattlerSpawned: (b) => window.dispatchEvent(new CustomEvent('reel:battler', { detail: { ...b, event: 'spawn' } })),
      onBattlerRemoved: (key) => window.dispatchEvent(new CustomEvent('reel:battler', { detail: { key, event: 'remove' } })),
      onBattlerClick: () => {},
      onBattlerDone: (key, done) => window.dispatchEvent(new CustomEvent('reel:battler', { detail: { key, done, event: 'done' } }))
    });
  };
  buildCast();

  /** Trimmed GardenScene `applyState`: status, busy ownership, working
   *  wander, tool bubbles. */
  const reconcile = (): void => {
    for (const session of sessions.values()) {
      const rt = runtimes.get(session.id) ?? lifecycle.addWalker(asSession(session));
      const { walker } = rt;
      rt.status = session.status;
      walker.setStatus(session.status);
      walker.setLabel(session.title);
      const owned = battles.isBattling(session.id) || walker.isRecalling;
      walker.setBusy(owned);
      if (!owned && session.status !== 'working') {
        rt.lastStation = null;
      } else if (!owned && rt.lastStation !== 'wander') {
        walker.beginWander();
        if (!walker.isEvolving) rt.lastStation = 'wander';
      }
      if (battles.isBattling(session.id)) {
        walker.hideBubble();
        continue;
      }
      const toolKey = `${session.status}|${session.tool ?? ''}|${session.toolTarget ?? ''}`;
      if (toolKey === lastTool.get(session.id)) continue;
      lastTool.set(session.id, toolKey);
      if (session.status === 'working' && session.tool) {
        walker.showTool(session.tool, formatBubbleLabel(session.tool, session.toolTarget) || '');
      } else if (session.status === 'working') {
        walker.showTool('', '...');
      } else {
        walker.lingerBubble();
      }
    }
  };

  let subject: CameraSubject = { kind: 'wide' };
  let snapNext = false;
  const coverZoom = (): number => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    return Math.max(w / mapWidthPx, h / mapHeightPx);
  };
  const aimCamera = (): void => {
    if (subject.kind === 'fit') {
      camera.fitToScreen();
      return;
    }
    if (subject.kind === 'wide') {
      camera.focusOn(mapWidthPx / 2, mapHeightPx / 2, coverZoom());
      return;
    }
    const zoomFor = (z?: number): number => Math.max(coverZoom(), z ?? 2.4);
    if (subject.kind === 'walker') {
      const rt = runtimes.get(subject.id);
      if (!rt) return;
      camera.focusOn(rt.walker.worldX + borderPx, rt.walker.worldY - 12 + borderPx, zoomFor(subject.zoom));
      return;
    }
    const parent = runtimes.get(subject.parentId);
    const foe = battles.getBattlerPosition(subject.key);
    if (!parent) return;
    const x = foe ? (parent.walker.worldX + foe.x) / 2 : parent.walker.worldX;
    const y = foe ? (parent.walker.worldY + foe.y) / 2 : parent.walker.worldY;
    // Frame BOTH combatants: zoom out as far as needed (down to Camera's own
    // fit-the-map minimum) so the pair plus a sprite-sized margin fits.
    let zoom = subject.zoom ?? 2.4;
    if (foe) {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      const spanX = Math.abs(parent.walker.worldX - foe.x) + 140;
      const spanY = Math.abs(parent.walker.worldY - foe.y) + 170;
      zoom = Math.min(zoom, w / spanX, h / spanY);
    }
    camera.focusOn(x + borderPx, y - 30 + borderPx, zoom);
  };

  /** Screen-space (canvas CSS px) positions of the current camera subject(s)
   *  — for the dev-only framing check (reel.ts exposes it). */
  const subjectScreenPoints = (): { x: number; y: number }[] => {
    const pts: { x: number; y: number }[] = [];
    const push = (c: Container | undefined): void => {
      if (!c || c.destroyed) return;
      const g = c.getGlobalPosition();
      pts.push({ x: g.x, y: g.y });
    };
    if (subject.kind === 'walker') push(runtimes.get(subject.id)?.walker.container);
    if (subject.kind === 'battle') {
      push(runtimes.get(subject.parentId)?.walker.container);
      const pos = battles.getBattlerPosition(subject.key);
      if (pos) {
        const g = charLayer.toGlobal(pos);
        pts.push({ x: g.x, y: g.y });
      }
    }
    return pts;
  };

  const tickListeners: ((dtMs: number) => void)[] = [];
  let reconcileAccum = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    try {
      map.update(dt * 1000);
      for (const rt of runtimes.values()) rt.walker.update(dt);
      battles.update(dt);
      dayNight.update(dt);
      gardenCharm.updatePulses(dt);
      // A battle hand-off (onBattleEnd) or ceremony end changes ownership
      // without any "store" write, so re-run the reconcile a few times a second.
      reconcileAccum += dt;
      if (reconcileAccum >= 0.25) {
        reconcileAccum = 0;
        reconcile();
      }
      aimCamera();
      if (snapNext) {
        snapNext = false;
        // Camera keeps its lerp state private; bracket access is the one
        // escape hatch TS allows, and only the reel needs a hard cut.
        camera['currentX'] = camera['targetX'];
        camera['currentY'] = camera['targetY'];
        camera['currentZoom'] = camera['targetZoom'];
      }
      camera.update();
      for (const cb of tickListeners) cb(dt * 1000);
    } catch (e) {
      console.error('[showreel] tick threw', e);
    }
  });

  const clearHourOverride = (): void => {
    try {
      window.localStorage.removeItem(HOUR_OVERRIDE_KEY);
    } catch {
      /* storage blocked — nothing was written either */
    }
  };

  const teardownCast = (): void => {
    for (const id of [...runtimes.keys()]) lifecycle.removeWalker(id);
    battles.dispose();
    clearBattleFx();
    sessions.clear();
    lastTool.clear();
  };

  return {
    host,
    get battles() {
      return battles;
    },
    sessions,
    runtime: (id) => runtimes.get(id),
    debugFraming: () => ({
      kind: subject.kind,
      width: host.clientWidth,
      height: host.clientHeight,
      points: subjectScreenPoints()
    }),
    upsert(session) {
      sessions.set(session.id, session);
      reconcile();
    },
    patch(id, p) {
      const s = sessions.get(id);
      if (!s) return;
      Object.assign(s, p);
      reconcile();
    },
    remove(id) {
      sessions.delete(id);
      lifecycle.removeWalker(id);
    },
    evolve(id) {
      const s = sessions.get(id);
      const rt = runtimes.get(id);
      if (s && rt && !rt.walker.isEvolving && !rt.evolvePending) lifecycle.triggerEvolve(asSession(s), rt);
    },
    setExcludedLines(lines) {
      excludedLines = lines;
    },
    setCamera(next) {
      subject = next;
    },
    snapCamera() {
      snapNext = true;
    },
    setNight(hour) {
      // DayNightOverlay's own QA hour override ('poke:daynightHourOverride',
      // read on every recompute) drives a real dusk crossfade in 'auto'
      // mode; if storage is unavailable, fall back to the hard 'night' mode.
      if (hour === 'day') {
        clearHourOverride();
        dayNight.setModeOverride('day');
        return;
      }
      try {
        window.localStorage.setItem(HOUR_OVERRIDE_KEY, String(hour));
        dayNight.setModeOverride('auto');
      } catch {
        dayNight.setModeOverride('night');
      }
    },
    setBackground(color) {
      app.renderer.background.color = color;
    },
    onTick(cb) {
      tickListeners.push(cb);
    },
    setPaused(paused) {
      if (paused) {
        app.ticker.stop();
        Ticker.shared.stop();
      } else {
        app.ticker.start();
        Ticker.shared.start();
      }
    },
    reset() {
      teardownCast();
      buildCast();
      subject = { kind: 'wide' };
    },
    destroy() {
      ro.disconnect();
      teardownCast();
      clearHourOverride();
      gardenCharm.destroy();
      dayNight.destroy();
      Ticker.shared.start();
      app.destroy(true, { children: true });
    }
  };
}
