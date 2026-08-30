import { useEffect, useRef, useState } from 'react';
import { Application, Container, Rectangle } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
// Pixi 8 compiles shader/uniform code with `new Function` by default, which the
// renderer's CSP (no 'unsafe-eval') forbids. This is Pixi's own supported
// no-eval path; it must be imported before an Application is created.
import 'pixi.js/unsafe-eval';
import { TiledMapRenderer, type TiledMap, type Point } from './TiledMapRenderer';
import { buildMapBorder, DEFAULT_GARDEN_BORDER } from './mapBorder';
import { DayNightOverlay } from './DayNightOverlay';
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
import { GardenCharm } from './gardenCharm';
import { ClosingRitual } from './ClosingRitual';
import { emitClosingRitualSignal, onClosingRitualSignal } from './closingRitualBus';
import { clearBattleFx, spawnShinySparkle, spawnSparkleBurst } from './battle/battleFx';
import { playSpawnCry, playSelectCry } from '@/audio/audioEngine';
import { ArceusWarp } from '@/components/ArceusWarp';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
// The map keeps its Tiled `.tmj` extension so a real Tiled export can be dropped
// in verbatim; Vite has no JSON loader for that extension, hence `?raw` + parse.
import gardenMapRaw from './maps/garden.tmj?raw';
import { useStore, type LiveBattler, type Session } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { GARDEN_SPLIT_DRAG_END_EVENT } from '@/gardenSplit';
import type { StationKind } from '@shared/types';
import { ground, hexToNumber } from '@/design/tokens';
import { formatBubbleLabel } from '@/design/toolTargetLabel';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { markRendererTick } from '@/diagnosticsCounters';
import { isClosingTimeActive } from '@/closingTime';

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
  /** The species id currently reflected in this walker's sprite. Kept in
   *  sync with `session.pokemon` by triggerEvolve's own ceremony swap AND by
   *  applyManualSwap (the roster card's "change pokemon" action) — the
   *  latter diffs against THIS, not `session.pokemon` read fresh, so a swap
   *  is applied exactly once even though `session.pokemon` itself doesn't
   *  change again until the next swap or evolution. */
  appliedPokemonId: string;
}

export function GardenScene(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  // Closing-time sunset overlay (Phase 8.5 Wave B item 2) — a CSS layer on
  // `.garden-mat` (not a Pixi layer: it needs to cover the whole mat,
  // including the letterbox, and mustn't scale with the camera or be
  // crushed by an in-flight evolution ceremony's own dim overlay). Plain
  // React state is fine here even though the rest of this component is
  // imperative Pixi: this is the one piece of UI actually in the React tree
  // (see the JSX return below).
  const [ritualActive, setRitualActive] = useState(false);
  // WebGL context-loss recovery (garden-ui-crash triage,
  // 2026-08-29 — docs/triage/2026-08-29-garden-ui-crash.md): flips true only
  // once the auto-rebuild attempt cap (below) is exhausted, showing a plain
  // in-place fallback over the dead canvas — same "log it, offer a manual
  // way out" idiom as ErrorBoundary.tsx's own render-error fallback.
  // `manualRebuildRef` is how that fallback's button reaches the rebuild
  // function living inside the imperative effect below (it's assigned there,
  // once, before the initial mount).
  const [crashed, setCrashed] = useState(false);
  const manualRebuildRef = useRef<() => void>(() => {});
  // The cosmos warp — active (target = cosmos) exactly when Arceus is the
  // selected session. A pure derived value (no lifecycle to manage, unlike
  // `ritualActive` above), so it reads straight off the store rather than
  // being toggled from inside the imperative Pixi effect below — that
  // effect never needs to know about it at all: the warp is entirely owned
  // by ArceusWarp.tsx's own JSX/inline styles, separate from the
  // simulation running underneath (which keeps going, unaffected, while
  // the garden host is warped away).
  const ascended = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Rebuild plumbing (garden-ui-crash triage, 2026-08-29): `mountScene`
    // below is exactly the old effect body (app init through the map/
    // walkers/battle setup) — unchanged except that it now assigns its own
    // teardown to `currentCleanup` instead of a variable local to the
    // effect, so it can be re-invoked to tear down a dead renderer and build
    // a fresh one in its place without a second, parallel init path.
    // `rebuild` is the ONE place that actually does that: it reuses
    // `currentCleanup` (the same function component-unmount would call —
    // detaches every listener/ticker on the OLD canvas, including the
    // webglcontextlost/restored pair added below, since a rebuilt
    // Application means a brand-new canvas needing its own) and then calls
    // `mountScene` again for the fresh Application. `rebuildInFlight` caps
    // it at one in-flight rebuild — a second signal (e.g. a stray restore
    // event) while one is already running just logs and no-ops rather than
    // racing a second teardown/rebuild against the first.
    //
    // `rebuildAttempts` caps how many times the 2s alarm may trigger this
    // AUTOMATICALLY per context-loss EVENT before giving up and showing the
    // crash overlay — a genuine crash loop (losses within
    // REBUILD_BUDGET_RESET_MS of the last attempt) keeps counting toward the
    // same budget, but a loss that lands well after the last attempt (the
    // rebuilt renderer ran fine for a while, then something unrelated —
    // sleep/wake, a driver reset — took it out again) reads as a NEW event
    // and gets a fresh budget rather than inheriting a stale count. The
    // overlay's manual "rebuild" button also resets it outright, since
    // that's a deliberate user retry either way.
    let currentCleanup: (() => void) | null = null;
    let rebuildInFlight = false;
    let rebuildAttempts = 0;
    let lastRebuildAttemptAt = 0;
    const MAX_REBUILD_ATTEMPTS = 2;
    const REBUILD_BUDGET_RESET_MS = 60_000;
    // Snapshot of the store's `battlers` slice taken right before teardown —
    // `currentCleanup()` below tears down the old BattleManager, and its
    // `destroyBattle` calls `onBattlerRemoved` for every live battler
    // (GardenScene wires that to `removeBattler`), so by the time the fresh
    // `mountScene()` reconciles, the store's own `battlers` array is already
    // empty. This is what `respawnFromStore` (below, inside `mountScene`)
    // actually reads instead.
    let pendingRespawn: LiveBattler[] = [];

    const rebuild = async (): Promise<void> => {
      if (rebuildInFlight) {
        safeLogDiagnostic('gpu', 'info', 'context-loss signal ignored — rebuild already in flight', {});
        return;
      }
      if (lastRebuildAttemptAt && Date.now() - lastRebuildAttemptAt > REBUILD_BUDGET_RESET_MS) {
        rebuildAttempts = 0;
      }
      if (rebuildAttempts >= MAX_REBUILD_ATTEMPTS) {
        safeLogDiagnostic('gpu', 'error', 'garden rebuild attempts exhausted — showing crash overlay', {
          attempts: rebuildAttempts
        });
        // Give up on this generation for real rather than leaving a dead
        // renderer (and its ticker) running invisibly behind the overlay.
        currentCleanup?.();
        currentCleanup = null;
        setCrashed(true);
        return;
      }
      rebuildInFlight = true;
      rebuildAttempts += 1;
      lastRebuildAttemptAt = Date.now();
      safeLogDiagnostic('gpu', 'error', 'webgl context not restored — rebuilding renderer', {
        attempt: rebuildAttempts
      });
      try {
        pendingRespawn = useStore.getState().battlers.slice();
        currentCleanup?.();
        currentCleanup = null;
        await mountScene();
        setCrashed(false);
        safeLogDiagnostic('gpu', 'info', 'garden renderer rebuilt successfully', { attempt: rebuildAttempts });
      } catch (e) {
        safeLogDiagnostic('gpu', 'error', 'garden renderer rebuild failed', {
          attempt: rebuildAttempts,
          error: e instanceof Error ? (e.stack ?? e.message) : String(e)
        });
        setCrashed(true);
      } finally {
        rebuildInFlight = false;
      }
    };
    // The crash overlay's own button (JSX below) — a deliberate user retry,
    // so it gets a fresh automatic budget rather than staying permanently
    // stuck at the cap from the earlier crash loop.
    manualRebuildRef.current = (): void => {
      rebuildAttempts = 0;
      void rebuild();
    };

    const mountScene = async (): Promise<void> => {
      const app = new Application();
      let destroyed = false;
      let cleanup: (() => void) | null = null;
      // Assigned immediately (not after `init` resolves) so an unmount or a
      // rebuild that lands while the async loads below are still in flight
      // still reaches THIS generation's `destroyed`/`cleanup` — `cleanup`
      // itself stays null until `init` finishes setting it up, at which
      // point this closure already sees the live binding.
      currentCleanup = (): void => {
        destroyed = true;
        cleanup?.();
      };

      const init = async (): Promise<void> => {
      await app.init({
        // Chrome ground (design/tokens.ts `ground[0]`), not a separate green —
        // any letterbox bars inside the canvas (map aspect != pane aspect)
        // should read as the same neutral ground the mat around it sits on.
        background: hexToNumber(ground[0]),
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

      // WebGL/GPU context-loss instrumentation (garden-ui-crash triage,
      // 2026-08-29 — docs/triage/2026-08-29-garden-ui-crash.md): a lost
      // context used to leave the canvas silently dead with ZERO trace in
      // harness.log — no renderer JS exception (nothing throws; lost-context
      // GL calls are spec'd no-ops), no main-process signal, nothing. Pixi's
      // own GlContextSystem already listens for these same two events on
      // this canvas, calls `preventDefault()` on loss itself (required for
      // the browser to ever restore it) and rebuilds every renderer system's
      // GPU resources on restore, and the ticker below never stops ticking
      // through any of this — so a context the BROWSER actually restores
      // needs nothing further here beyond logging.
      //
      // CONFIRMED PRODUCTION FAILURE (2026-08-29, harness.log 10:59:53Z-
      // 11:00:03Z): that assumption only covers the case the browser DOES
      // restore it — here it never did, and Pixi's self-heal never got a
      // chance to run, leaving a permanently dead canvas with nothing to
      // recover it. The 2s alarm below now calls `rebuild()` (defined
      // above this scene's mount function) instead of only logging.
      const CONTEXT_RESTORE_TIMEOUT_MS = 2_000;
      const canvas = app.canvas;
      let contextLostAt = 0;
      let contextRestoreTimer: ReturnType<typeof setTimeout> | null = null;
      const onContextLost = (event: Event): void => {
        if (destroyed) return; // this generation is already being torn down
        event.preventDefault(); // required to allow the browser to restore it
        contextLostAt = Date.now();
        safeLogDiagnostic('gpu', 'error', 'webgl context lost', {
          statusMessage: (event as WebGLContextEvent).statusMessage || undefined
        });
        if (contextRestoreTimer) clearTimeout(contextRestoreTimer);
        contextRestoreTimer = setTimeout(() => {
          contextRestoreTimer = null;
          safeLogDiagnostic('gpu', 'error', 'webgl context lost, not restored after 2s', {});
          void rebuild();
        }, CONTEXT_RESTORE_TIMEOUT_MS);
      };
      const onContextRestored = (): void => {
        if (destroyed) {
          // Stale event from a generation already torn down (e.g. a rebuild
          // already underway) — the listener normally can't outlive its own
          // removeEventListener call in `cleanup`, but this is the same
          // "subsequent signals no-op with a log row" guard `rebuild` itself
          // uses, kept here too for defense-in-depth.
          safeLogDiagnostic('gpu', 'info', 'context restored signal ignored — this generation already torn down', {});
          return;
        }
        if (contextRestoreTimer) {
          clearTimeout(contextRestoreTimer);
          contextRestoreTimer = null;
        }
        safeLogDiagnostic('gpu', 'info', 'webgl context restored', {
          downtimeMs: contextLostAt ? Date.now() - contextLostAt : null
        });
      };
      canvas.addEventListener?.('webglcontextlost', onContextLost, false);
      canvas.addEventListener?.('webglcontextrestored', onContextRestored, false);

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

      // Themed border ring (Backlog: "themed borders") — drawn unshifted, at
      // local (0, 0), spanning `border.thickness` tiles wider than the map
      // on every side; `content` below (the map's own container plus the
      // evolution overlay layers, everything already in the map's own
      // tile-index-derived coordinate space) is offset by exactly that
      // thickness so its content lands INSIDE the ring instead of under it.
      // Nothing about TiledMapRenderer's own tile-index space (walkability,
      // spawn points, zones, pathfinding) changes — this is presentation
      // only, entirely outside that space.
      const border = buildMapBorder(gardenMap, tilesets, DEFAULT_GARDEN_BORDER);
      world.addChild(border);
      const borderPx = DEFAULT_GARDEN_BORDER.thickness * map.tileSize;
      const content = new Container();
      content.position.set(borderPx, borderPx);
      world.addChild(content);

      content.addChild(map.getContainer());
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
      // All three are children of `content` (not `world` directly) so the
      // border offset above applies to them too — otherwise their dim/flash
      // overlays (sized off the map's own untranslated pixel dimensions,
      // see EvolutionCeremony.ts's `mapWidthPx`/`mapHeightPx`) would drift
      // out of alignment with the walkers they're meant to cover.
      const evolutionDimLayer = new Container();
      const evolutionFlashLayer = new Container();
      const evolutionCeremonyLayer = new Container();
      content.addChild(evolutionDimLayer, evolutionFlashLayer, evolutionCeremonyLayer);
      console.log(
        `[garden] map ${map.width}x${map.height} tiles, ${map.tileSpriteCount} tile sprites, ` +
          `${map.getAllSpawnPoints().size} spawn points, ${map.getAllZones().size} zones`
      );

      const camera = new Camera(world);
      const mapWidthPx = (map.width + DEFAULT_GARDEN_BORDER.thickness * 2) * map.tileSize;
      const mapHeightPx = (map.height + DEFAULT_GARDEN_BORDER.thickness * 2) * map.tileSize;
      camera.setMapSize(mapWidthPx, mapHeightPx);

      // Day/night cycle (Backlog: "day/night animation pass") — ambient
      // lighting overlay sitting above EVERYTHING in `world` (border, tiles,
      // walkers alike), built fresh here so a context-loss rebuild
      // (`mountScene` re-running) gets its own new overlay + rim snapshot
      // the same as every other per-mount object above, and torn down by
      // this generation's own `cleanup` below. The moon pool anchors on
      // garden.tmj's actual 'pond' zone rather than the day-night recipe's
      // original mock-crop fraction (see DayNightOverlay.ts's header); the
      // fallback below is only for a future map edit that renames or
      // removes that zone, so the pool never silently disappears instead of
      // just landing slightly off. Sized to `mapWidthPx`/`mapHeightPx`
      // (border-inclusive) rather than the map's own tile bounds — the
      // border ring gets darkened/vignetted at night too, so the frame
      // doesn't glow daylight against a night sky.
      const zoneCenterPx = (zoneName: string, fallback: Point): Point => {
        const zone = map.getZone(zoneName);
        if (!zone) return fallback;
        return {
          x: (zone.x + zone.width / 2) * map.tileSize + borderPx,
          y: (zone.y + zone.height / 2) * map.tileSize + borderPx
        };
      };
      const dayNight = new DayNightOverlay({
        widthPx: mapWidthPx,
        heightPx: mapHeightPx,
        poolCenter: zoneCenterPx('pond', { x: mapWidthPx * 0.73, y: mapHeightPx * 0.39 }),
        // Deliberately NOT snapped to garden.tmj's 'gate' zone (unlike the
        // pool above): that zone sits bottom-center on this map, and
        // clustering all 3 lamps into the bottom band would break the
        // approved composition — the user iterated 4 times on this exact
        // upper-middle-plus-two-corners layout. Composition fidelity to the
        // approved mock wins over landmark snapping for this one light.
        gateLampCenter: { x: mapWidthPx * 0.4531, y: mapHeightPx * 0.3611 },
        staticTiles: map.getContainer(),
        liveLayer: charLayer,
        staticTilesWidthPx: map.width * map.tileSize,
        staticTilesHeightPx: map.height * map.tileSize,
        staticTilesOffsetPx: { x: borderPx, y: borderPx }
      });
      dayNight.mount(app.renderer, world);

      // Free-look input (garden camera lock-on gap): `world` itself becomes
      // the interactive "background" catch-all — Pixi's hit test always
      // checks children first, so a click/drag that actually lands on a
      // walker (Walker.ts sets its own container `eventMode: 'static'`) or a
      // gardenCharm hotspot (well/signpost) still resolves `event.target` to
      // THAT object, not `world`; only an otherwise-unclaimed point (bare
      // ground, the decorative border) resolves to `world`. That's the
      // signal every handler below uses to tell "empty ground" apart from
      // "something already interactive".
      world.eventMode = 'static';
      world.hitArea = new Rectangle(0, 0, mapWidthPx, mapHeightPx);

      // Drag-to-pan: a press that starts on empty ground (see the `world`
      // hit-testing comment above) either pans the camera (moved past
      // DRAG_THRESHOLD_PX) or, on release with no real movement, performs
      // the view-mode-specific background-click action. Coordinates are tracked in canvas-space
      // (CSS px, matching `camera`'s viewWidth/viewHeight) throughout: the
      // drag start comes from Pixi's `event.global` (already canvas-space),
      // continued tracking uses native `pointermove`/`pointerup` on
      // `window` — not Pixi's own global-move events — so a drag that
      // leaves the canvas mid-gesture (or ends there) is never silently
      // dropped.
      const DRAG_THRESHOLD_PX = 4;
      let dragState: {
        // Captured once at drag start, not re-read every move — a
        // `getBoundingClientRect()` per pointermove would be a synchronous
        // layout read at mouse-move frequency, exactly the kind of
        // per-frame cost this app's CPU budget can't afford.
        rect: DOMRect;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        moved: boolean;
      } | null = null;

      const onWorldPointerDown = (e: FederatedPointerEvent): void => {
        // Only the primary (left) button starts a pan/deselect gesture, and
        // only when the press itself landed on `world` — a walker or charm
        // hotspot handles its own click and this gesture stays out of it.
        if (e.button !== 0 || e.target !== world) return;
        dragState = {
          rect: canvas.getBoundingClientRect(),
          startX: e.global.x,
          startY: e.global.y,
          lastX: e.global.x,
          lastY: e.global.y,
          moved: false
        };
      };
      world.on('pointerdown', onWorldPointerDown);

      const onWindowPointerMove = (e: PointerEvent): void => {
        if (!dragState) return;
        // The button was released (or the gesture cancelled) without this
        // window ever seeing the up event — e.g. released outside the app
        // window. Without this check a stray hover afterward would pan with
        // no button held.
        if (e.buttons === 0) {
          dragState = null;
          return;
        }
        const x = e.clientX - dragState.rect.left;
        const y = e.clientY - dragState.rect.top;
        if (!dragState.moved) {
          const totalDx = x - dragState.startX;
          const totalDy = y - dragState.startY;
          if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
          dragState.moved = true;
        }
        const dx = x - dragState.lastX;
        const dy = y - dragState.lastY;
        dragState.lastX = x;
        dragState.lastY = y;
        const zoom = camera.getZoom();
        camera.pan(-dx / zoom, -dy / zoom);
      };
      window.addEventListener('pointermove', onWindowPointerMove);

      const endDrag = (e: PointerEvent): void => {
        // Only a completed left-button press-then-release with no real
        // movement counts as the empty-ground click gesture. In split view it
        // enters fullscreen without changing selection; in fullscreen it
        // deselects and restores free-look. A right-click release (which never
        // started a drag) must not trigger either action.
        if (dragState && !dragState.moved && e.button === 0) {
          const { viewMode } = useStore.getState();
          if (viewMode === 'garden') {
            useStore.getState().setViewMode('gardenFull');
          } else if (viewMode === 'gardenFull') {
            // Breaks follow into free-look so the whole-map view isn't
            // immediately re-overridden by the selected-session camera.
            camera.setFreeLook(false);
            useStore.getState().select(null);
          }
        }
        dragState = null;
      };
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);

      // Wheel/trackpad-pinch zoom, centered on the cursor. `deltaY` sign:
      // scrolling "up"/pinching out is negative — that should zoom IN, hence
      // the negation in the exponent. Wheel events are far rarer than
      // pointermove, so a fresh `getBoundingClientRect()` per event here
      // isn't the cost the drag path above needs to avoid.
      const WHEEL_ZOOM_SENSITIVITY = 0.0015;
      const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
        camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      };
      canvas.addEventListener('wheel', onWheel, { passive: false });

      // Escape deselects (same free-look reset as a background click) while
      // the garden is the visible view — 'terminal' mode hides the garden
      // entirely, so Escape there has nothing to do here. Closing-time's own
      // Escape handler (App.tsx) owns Escape while a closing ritual is
      // active; this defers to it rather than double-handling the same key.
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || isClosingTimeActive()) return;
        const { viewMode, selectedId } = useStore.getState();
        if (viewMode !== 'garden' && viewMode !== 'gardenFull') return;
        // Nothing selected AND not free-looking means the view is already at
        // rest (fitToScreen) — nothing for Escape to do.
        if (selectedId == null && !camera.isFreeLook()) return;
        camera.setFreeLook(false);
        useStore.getState().select(null);
      };
      window.addEventListener('keydown', onKeyDown);

      // The canvas/camera's ONE source of truth for "how big is the pane
      // right now" — re-measures `host.clientWidth/Height` fresh rather
      // than trusting `app.init()`'s reading (taken before this scene's own
      // tileset/animation loads awaited above, and on macOS a
      // `titleBarStyle: 'hiddenInset'` window's content view can still be
      // settling its final size around then too). Used both for the
      // one-time initial fit below and every later ResizeObserver firing,
      // so there's exactly one code path that can leave the canvas
      // undersized relative to its host — not two that can silently
      // disagree. `app.renderer.resize` is a no-op if the size didn't
      // change, so calling this redundantly (e.g. the initial rAF pass
      // landing on a size the observer already applied) is harmless.
      const syncCanvasToHost = (): void => {
        // While the garden/terminal split is being dragged (`body.is-splitting`,
        // toggled by GardenSplitHandle.tsx), the ResizeObserver below still
        // fires on every rAF-throttled width change the drag produces.
        // `renderer.resize()` sets the canvas's drawing-buffer width/height
        // attributes, which the spec defines as clearing the bitmap — Pixi
        // doesn't re-render synchronously inside resize(), so that frame
        // paints blank and the next real frame lands a tick later. At drag
        // cadence that's a blank canvas most frames: the flicker. Skip the
        // real resize during the drag — the CSS in index.css stretches the
        // canvas to the container instead — and let the drag-end listener
        // below do one real resize the instant the drag ends.
        if (document.body.classList.contains('is-splitting')) return;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 2 || h < 2) return;
        app.renderer.resize(w, h);
        camera.setViewSize(w, h);
      };
      syncCanvasToHost();
      // One frame later, in case layout was still settling at the line
      // above (a still-in-flight reflow — e.g. the roster strip populating
      // from session restore, or the window's content view finishing its
      // own resize on macOS) — catches the "canvas sized smaller than its
      // pane, stuck that way" case a ResizeObserver started only THIS LATE
      // (after this scene's own async loads) can otherwise miss if the
      // host's size already finished changing before it started watching.
      requestAnimationFrame(() => {
        if (!destroyed) syncCanvasToHost();
      });

      const patchPool = new SeatPool(STATION_SPAWNS.patch);
      const runtimes = new Map<string, Runtime>();

      // Select-cry (Phase 8 §4): seeded from the CURRENT selection, not null,
      // so a restore-on-boot (or the initial `applyState()` call right after
      // `subscribe`, below) never fires a cry/bounce for a selection nobody
      // just picked — only an actual change after mount does.
      let lastSelectedId: string | null = useStore.getState().selectedId;
      // A subagent-card click can leave `selectedId` unchanged (its parent
      // was already selected) — the `selectedId !== lastSelectedId` check
      // below (which cancels free-look on a real selection change) would
      // then never fire, so a battler focus set while the camera is
      // free-looking (panned/zoomed away) would silently do nothing.
      // Tracked separately so free-look cancels on the focus key's OWN
      // transition too, below.
      let lastFocusBattlerKey: string | null = useStore.getState().focusBattlerKey;

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
          // A "change pokemon" swap requested mid-battle is deferred by
          // applyManualSwap (defined below — safe to reference here: this
          // callback only ever RUNS once a battle actually ends, well after
          // the whole scene has finished setting up) until the battle is
          // over; apply it immediately now rather than waiting for the next
          // incidental store change to trigger applyState.
          const session = useStore.getState().sessions.find((s) => s.id === parentId);
          if (session) applyManualSwap(session, rt);
        },
        // Subagent roster presence (RosterStrip.tsx's SubagentRosterCard) —
        // BattleManager stays store-agnostic (see its own DI-style deps
        // above), so this is the one place that actually writes battler
        // presence into the zustand store.
        onBattlerSpawned: (battler) => useStore.getState().addBattler(battler),
        onBattlerRemoved: (key) => useStore.getState().removeBattler(key),
        onBattlerDone: (key, done) => useStore.getState().setBattlerDone(key, done)
      });

      // Phase 8 §7 — garden charm: berry-bush errands, idle chatter, and the
      // signpost/well clickable props. Same instantiate-here/destroy-in-
      // cleanup lifecycle as battleManager above, for the same reason (needs
      // this scene's own map/charLayer).
      const gardenCharm = new GardenCharm({
        map,
        layer: charLayer,
        onOpenSessions: () => useStore.getState().setSessionsOverviewOpen(true),
        onOpenSettings: () => useStore.getState().setSettingsOpen(true)
      });

      // Closing-time sunset ritual (Phase 8.5 Wave B item 2) — see
      // ClosingRitual.ts and closingRitualBus.ts. 'start'/'cancel' arrive
      // from closingTime.ts (settings button / Cmd+Shift+Q / Escape); this
      // is the only place a walker's own goTo is called for the ritual —
      // 'complete' flows back out so closingTime.ts can toast + quit.
      const closingRitual = new ClosingRitual(map);
      const offRitual = onClosingRitualSignal((signal) => {
        if (signal.type === 'start') {
          setRitualActive(true);
          const entries = new Map(
            [...runtimes].map(([id, rt]) => [id, { walker: rt.walker }])
          );
          closingRitual.start(entries, (wrappedCount) => {
            emitClosingRitualSignal({ type: 'complete', wrappedCount });
          });
        } else if (signal.type === 'cancel') {
          closingRitual.cancel();
          setRitualActive(false);
        }
        // 'complete' is closingTime.ts's own signal to itself (it's the one
        // that toasts + quits) — nothing for the scene to do with it, and
        // the overlay deliberately stays lit until the app actually quits.
      });

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
      const upgradeIfLazy = (
        session: Session,
        speciesId: string,
        shiny: boolean,
        walker: Walker,
        rt: Runtime
      ): void => {
        if (!shiny && pokemonAnimations.has(speciesId)) return;
        void loadLazyAnimation(speciesId, shiny).then((anim) => {
          if (runtimes.get(session.id) !== rt) return; // session gone/replaced meanwhile
          if (rt.appliedPokemonId !== speciesId) return; // superseded by a later evolve/swap meanwhile
          if (anim) {
            walker.setAnimation(anim);
          } else {
            const label = speciesEntry(speciesId)?.name ?? speciesId;
            useStore.getState().pushToast(`couldn't load ${label}'s sprite — offline or not found.`);
          }
          if (shiny) {
            spawnShinySparkle(walker.container, -walker.spriteHeight - 8);
            walker.showFloatingText('Shiny!');
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
          accentColor: session.accent,
          label: session.title,
          dimLayer: evolutionDimLayer,
          flashLayer: evolutionFlashLayer,
          ceremonyLayer: evolutionCeremonyLayer,
          onClick: (id) => {
            const store = useStore.getState();
            if (store.viewMode === 'garden') {
              store.select(id);
              store.setViewMode('gardenFull');
            } else if (store.viewMode === 'gardenFull') {
              store.select(id);
              store.setViewMode('garden');
              store.setDrawerOpen(true);
            }
          }
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
        const bundled = session.shiny ? undefined : pokemonAnimations.get(nextId);

        const proceed = (anim: PokemonAnimation, failed: boolean): void => {
          rt.evolvePending = false;
          if (runtimes.get(session.id) !== rt) return; // session gone meanwhile
          if (failed) {
            const label = speciesEntry(nextId)?.name ?? nextId;
            useStore.getState().pushToast(`couldn't load ${label}'s sprite — evolving with a placeholder.`);
          }
          const nextLabel = speciesEntry(nextId)?.name ?? nextId;
          rt.walker.evolve(anim, entry.name, nextLabel, nextId, () => {
            rt.appliedPokemonId = nextId;
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
        if (rt.walker.isEvolving || battleManager.isBattling(session.id)) return;
        rt.appliedPokemonId = session.pokemon;
        rt.walker.setAnimation(resolveAnimation(session.pokemon, session.shiny));
        spawnSparkleBurst(rt.walker.container);
        playSpawnCry(session.pokemon);
        upgradeIfLazy(session, session.pokemon, session.shiny, rt.walker, rt);
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
       *  drives the garden.
       *
       *  Workspaces (Phase 8.7): `runtimes` stays keyed off the FULL,
       *  cross-workspace session list on purpose — a session's walker is
       *  only ever created on first appearance and destroyed on actual
       *  removal, never on a workspace switch (spec: "keep switch cost low
       *  by letting Runtime/walker objects for inactive workspaces persist
       *  off-stage rather than being destroyed/rebuilt each switch"). Only
       *  visibility (this loop) and evolution-triggering (the ticker's 1Hz
       *  block, below) are scoped to the active workspace; everything else
       *  — status/tool reconcile, station targeting — is skipped outright
       *  for a hidden session (nothing to gain by pathing an invisible
       *  walker) and picks back up on the very next reconcile once its
       *  workspace becomes active again (this function is also subscribed
       *  to the workspace store, below, so a switch itself triggers one). */
      const applyState = (): void => {
        const { sessions, selectedId } = useStore.getState();
        const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
        const live = new Set(sessions.map((s) => s.id));
        for (const id of [...runtimes.keys()]) if (!live.has(id)) removeWalker(id);

        // Select-cry + party-screen hop (Phase 8 §4): ANY path that changes
        // `selectedId` — a tab, a roster card, the sessions overview, or
        // clicking the walker itself — reconciles through here, so this is
        // the single choke point for both. `playSelectCry` debounces on its
        // own; the null-check means
        // deselecting plays nothing.
        if (selectedId !== lastSelectedId) {
          lastSelectedId = selectedId;
          // Any actual selection change — a new pick or a deselect — cancels
          // free-look so the ticker's automatic focusOn/fitToScreen resumes
          // (re-follow: "selecting a session resumes follow exactly as
          // today"). The background-click/Escape handlers above also reset
          // this directly, since THEY can fire while `selectedId` is already
          // null (free-looking with nothing selected), a transition this
          // check alone would never see.
          camera.setFreeLook(false);
          if (selectedId) {
            const session = sessions.find((s) => s.id === selectedId);
            const rt = runtimes.get(selectedId);
            if (session) playSelectCry(session.pokemon);
            rt?.walker.bounce();
          }
        }

        for (const session of sessions) {
          // Arceus (Phase 8.8) is not part of the garden population at all
          // — no walker, no station, no wandering, no battles/errands. His
          // "cosmos" presence is a separate, purely visual transition on
          // the garden pane itself (see the ascent overlay in this
          // component's JSX/CSS), not anything in `runtimes`.
          if (session.isArceus) continue;
          const rt = runtimes.get(session.id) ?? addWalker(session);
          const { walker } = rt;
          // Kept in sync regardless of workspace visibility (below) — the
          // ticker's 1Hz workedMs accumulator (`rt.status === 'working'`)
          // reads this, and background sessions keep "working" the same as
          // a foreground one (Phase 8.7: work — and hence evolution
          // progress — doesn't pause just because you switched gardens).
          rt.status = session.status;

          // Workspace visibility (Phase 8.7) — a session's walker AND its
          // battle visuals (BattleManager.setVisible; see that method's own
          // comment for why it's a separate call, not automatic) go dark
          // together the moment its workspace isn't the active one. Applied
          // before the early-continue below so a battle that's mid-fight
          // when its workspace goes inactive is hidden on the very next
          // reconcile, not left showing until something else changes it.
          const inActiveWorkspace = sessionWorkspaceId(session) === activeWorkspaceId;
          walker.container.visible = inActiveWorkspace;
          walker.bubbleContainer.visible = inActiveWorkspace;
          battleManager.setVisible(session.id, inActiveWorkspace);
          if (!inActiveWorkspace) continue;

          walker.setSelected(session.id === selectedId);
          // Phase 8.5 #3: `looping` is a flag orthogonal to `status` (see
          // loopDetector.ts's header) — reusing the existing name label for
          // its glyph, rather than adding a new pixi visual, keeps this off
          // the styling surface.
          walker.setLabel(session.looping ? `${session.title} (looping)` : session.title);
          walker.setStatus(session.status);
          // Napping (Phase 8.5 Wave B items 3/4) — plain-shell idle 30s+, or a
          // claude session between PreCompact and its post-compact
          // SessionStart. `Walker.setNapping` is idempotent on repeat calls
          // with the same value.
          walker.setNapping(!!session.napping);

          // "Change pokemon" (roster card action) — a no-op unless
          // session.pokemon has actually changed since this walker last
          // applied it; see applyManualSwap's own comment.
          applyManualSwap(session, rt);

          // A battling parent owns its own walker's position/facing for the
          // duration (approach/faceoff/attack loop) — the normal station
          // reconcile stands down until BattleManager hands it back via
          // onBattleEnd, which resets lastStation so this picks up again. A
          // napping walker owns its own position the same way — it stays
          // parked until it wakes.
          if (!battleManager.isBattling(session.id) && !walker.isNapping) {
            // Free-roam (Phase 8.9): only a blocked session is pinned, to the
            // signpost, as a deliberate "needs your attention" signal. Every
            // other status — including working — wanders the whole map, so
            // `session.station` (still populated by hookRouter/ptyParser for
            // a possible future per-tool toggle) goes unread here.
            const station: StationKind = session.status === 'blocked' ? BLOCKED_STATION : 'wander';

            if (station !== rt.lastStation) {
              if (station === 'wander') {
                walker.beginWander();
                // beginWander() no-ops while an evolution ceremony owns the
                // walker (see its own guard) — leave lastStation alone so
                // this retries once the ceremony ends, same contract as the
                // failed-goTo branch below, instead of recording a wander
                // that never actually started.
                if (!walker.isEvolving) rt.lastStation = station;
              } else if (walker.goTo(spawnTileFor(station, rt.slot, walker.canFly))) {
                rt.lastStation = station;
              }
              // A failed goTo leaves lastStation alone so the next status change
              // retries rather than assuming the walker is en route.
            }
          }

          if (battleManager.isBattling(session.id)) {
            // Mid-battle, the choreography's own exclaim/move-text bubbles
            // own this space above the head — and it's exactly where the
            // status badge normally sits too (see the blocked case below),
            // so the ordinary tool bubble has no business showing here.
            // Deliberately does NOT touch rt.lastToolKey: skip the whole
            // reconcile below rather than compute-and-discard, so the
            // ordinary tool-bubble state picks back up correctly the moment
            // the battle ends instead of reading as unchanged.
            walker.hideBubble();
          } else {
            const toolKey = `${session.status}|${session.tool ?? ''}|${session.toolTarget ?? ''}|${session.looping ? 1 : 0}|${!!session.napping}`;
            if (toolKey !== rt.lastToolKey) {
              rt.lastToolKey = toolKey;
              if (session.looping) {
                walker.showText('looping');
              } else if (session.napping) {
                walker.hideBubble();
              } else if (session.status === 'working' && session.tool) {
                walker.showTool(session.tool, formatBubbleLabel(session.tool, session.toolTarget) || '');
              } else if (session.status === 'working') {
                walker.showTool('', '...');
              } else if (session.status === 'blocked') {
                // The pulsing "!" badge above the head (Walker.redrawBadge)
                // already carries this — a "needs you" bubble stacked on
                // the exact same spot reads as overlapping clutter
                // (screenshot-confirmed), so leave the bubble hidden rather
                // than duplicate the signal.
                walker.hideBubble();
              } else {
                walker.lingerBubble();
              }
            }
          }
        }
      };

      const unsubscribe = useStore.subscribe(applyState);
      // Workspace switches (Phase 8.7) don't touch the session store at all
      // — subscribing here too is what makes a switch itself re-run the
      // visibility pass (and the full per-session reconcile for whichever
      // workspace just became active, catching it up on anything that
      // changed while it was hidden) instead of waiting for the next
      // unrelated session-store change.
      const unsubscribeWorkspace = useWorkspaceStore.subscribe(applyState);
      applyState();

      // Context-loss recovery (garden-ui-crash triage, 2026-08-29): on a
      // normal first mount `pendingRespawn` is always empty (nothing has
      // battled yet), so this is a no-op then — it only does real work
      // coming out of `rebuild()`, which snapshots the store's `battlers`
      // slice into `pendingRespawn` BEFORE tearing down the old
      // BattleManager (whose teardown removes every one of them from the
      // store as a side effect — see `pendingRespawn`'s own comment above).
      // Reuses BattleManager's own spawn machinery (`respawnFromStore`)
      // rather than a parallel one; species/parent is preserved, lifecycle
      // resets to roaming — or, done/retired follow-up, to 'retired' when
      // the pre-teardown snapshot's own `done` was true, since a rebuild
      // must not silently un-retire a battler the user hasn't despawned
      // (same "position can reset to spawn/wander" latitude the walker
      // rebuild above takes for everything else). A battler that can't be
      // faithfully respawned (its parent's walker is gone, or its species
      // has no sprite) is logged and left out of the store rather than
      // re-added as a roster card with no sprite behind it; every other one
      // is re-added (`addBattler` stamps a fresh `spawnedAt` — the
      // subagent card's elapsed-time readout restarts from this rebuild,
      // not the battler's original spawn — `done`/`doneAt` pass through
      // unchanged either way, straight from the snapshot).
      const toRespawn = pendingRespawn;
      pendingRespawn = [];
      const unrespawnable = new Set(battleManager.respawnFromStore(toRespawn));
      for (const battler of toRespawn) {
        if (unrespawnable.has(battler.key)) {
          safeLogDiagnostic('battle-spawn', 'warn', 'battler could not be respawned after garden rebuild — dropped', {
            key: battler.key
          });
        } else {
          useStore.getState().addBattler(battler);
        }
      }

      // Evolution's threshold check needs accumulated working-ms, which only
      // needs to be accurate to about a second — flushing every frame would
      // mean a store write (and an applyState reconcile) 60 times a second.
      let flushAccum = 0;
      // Battle-update throw guard (see the ticker's own try/catch below):
      // logged once, not every frame, so a persistent throw can't spam
      // harness.log at 60Hz the way a bare per-frame console.error used to
      // spam devtools with nothing captured at all.
      let loggedBattleUpdateThrow = false;
      // Ticker-wide throw guard (BACKLOG friend-testing readiness) — the
      // per-parent battle isolation below only covers battleManager.update();
      // an uncaught throw anywhere ELSE in this callback (map/walker update,
      // the evolution/charm block, camera) would propagate out of the
      // listener and skip Pixi's own render call for the rest of this tick,
      // same "dead black screen" failure mode battleManager's own comment
      // describes — and with zero trace in harness.log, since this is the
      // garden's one ticker, not something any other try/catch here covers.
      // Logged once, not every frame, same rationale as
      // loggedBattleUpdateThrow above. `markRendererTick()` runs before this
      // try so the 60s counters snapshot's heartbeat still looks alive even
      // while every frame after it throws — this log line is the only other
      // witness to that.
      let loggedTickerThrow = false;

      app.ticker.add((ticker) => {
        markRendererTick(); // renderer-alive heartbeat (see diagnosticsCounters.ts)
        try {
        const dt = Math.min(ticker.deltaMS / 1000, 0.1);
        map.update(dt * 1000);
        for (const rt of runtimes.values()) {
          rt.walker.update(dt);
          if (rt.status === 'working') rt.workAccumMs += dt * 1000;
        }
        // Runs after every walker's own update() so battle positioning always
        // overwrites with a fresh absolute (base + offset) value rather than
        // fighting Walker's own syncPosition from a stale frame. Guarded: an
        // uncaught throw here would propagate out of this ticker listener and
        // skip Pixi's OWN render call for the rest of this tick (added at
        // lower priority, so it runs after everyone else's) — if that kept
        // happening every frame (e.g. several subagent battles overlapping),
        // the canvas would simply stop being repainted and read as a dead
        // black screen the next time anything (a resize, a DPI change)
        // cleared it. One bad battle must never take the whole garden down
        // with it — log once and skip this frame's battle visuals instead.
        try {
          battleManager.update(dt);
        } catch (e) {
          // BattleManager.update() now isolates each parent's own battle in
          // its own try/catch (Phase A rework), so reaching here at all
          // means something outside that isolation broke — worth surfacing
          // for real. A bare console.error here previously left a per-frame
          // throw with ZERO trace in harness.log (diagnosticsClient.ts only
          // captures window.onerror/unhandledrejection and explicit
          // safeLogDiagnostic calls, not caught console.error) — this is
          // exactly how v1.2.0's invisible-subagent bug went unlogged for
          // 30+ minutes. Logged once, not every frame (see
          // loggedBattleUpdateThrow above), since a persistent throw would
          // otherwise fire this at 60Hz.
          console.error('[battle] update() threw — skipping this frame:', e);
          if (!loggedBattleUpdateThrow) {
            loggedBattleUpdateThrow = true;
            safeLogDiagnostic('battle', 'error', 'battleManager.update() threw outside per-parent isolation', {
              error: e instanceof Error ? (e.stack ?? e.message) : String(e)
            });
          }
        }
        closingRitual.update(dt);
        dayNight.update(dt);

        flushAccum += dt;
        if (flushAccum >= 1) {
          flushAccum = 0;
          const cfg = evolutionConfig();
          // Workspaces (Phase 8.7): workedMs keeps accumulating for EVERY
          // session regardless of workspace (below) — a background session
          // is still doing real work. Only the CEREMONY (triggerEvolve) is
          // gated on the active workspace: it reparents the walker into the
          // shared evolutionCeremonyLayer and lights the shared dim/flash
          // layers, which aren't workspace-scoped, so starting one for a
          // hidden session would flash the ACTIVE garden. Deferring is
          // free — `workedMs` stays past the threshold, so this same check
          // fires it on the very next 1Hz tick after the workspace becomes
          // active again, no separate "catch up" path needed.
          const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          for (const session of useStore.getState().sessions) {
            const rt = runtimes.get(session.id);
            if (!rt || rt.workAccumMs <= 0) continue;
            const workedMs = session.workedMs + rt.workAccumMs;
            rt.workAccumMs = 0;
            useStore.getState().updateSession(session.id, { workedMs });

            if (sessionWorkspaceId(session) !== activeWorkspaceId) continue;
            // "keep at this stage — don't evolve" (Phase C follow-up, roster
            // card's change-pokemon dialog) — `workedMs` above still
            // accumulated normally, this just withholds the ceremony trigger
            // the same way the workspace check above does, so unfreezing
            // resumes on the very next tick rather than needing a catch-up
            // path of its own.
            if (session.evolutionFrozen) continue;
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

          // Charm ticks at the same 1Hz cadence — no need for per-frame
          // precision on ambient errands/chatter.
          const sessions = useStore.getState().sessions;
          const walkersById = new Map<string, Walker>();
          for (const [id, rt] of runtimes) walkersById.set(id, rt.walker);
          gardenCharm.tick(sessions, walkersById);
        }

        // Despawn requests (SubagentRosterCard's despawn button, done
        // battlers only) — queued in the store since a React click can't
        // reach BattleManager directly (it lives inside this effect, not
        // anywhere React can import it); drained here, once per frame, same
        // "React sets a store flag, the ticker consumes it" pattern
        // `focusBattlerKey` below already uses. `despawnBattler` itself is
        // idempotent (double-despawn guard), so draining late by a frame or
        // two is harmless.
        for (const key of useStore.getState().drainDespawnBattlerKeys()) battleManager.despawnBattler(key);

        const { selectedId, focusBattlerKey } = useStore.getState();
        const focus = selectedId ? runtimes.get(selectedId) : undefined;
        // Subagent-card click (SubagentRosterCard.tsx): pan onto the
        // battler's OWN sprite instead of the parent walker `focus` above
        // resolves to — `getBattlerPosition` is already in the same
        // charLayer-local space `walker.worldX/worldY` are (both containers
        // are direct children of `charLayer`), so no extra conversion.
        // Undefined once the battler's gone (poofed/session ended) — falls
        // back to the normal follow-the-selection behavior below, and clears
        // the stale key so this stops re-checking it every frame.
        const battlerPos = focusBattlerKey ? battleManager.getBattlerPosition(focusBattlerKey) : undefined;
        if (focusBattlerKey && !battlerPos) useStore.getState().setFocusBattlerKey(null);
        // Cancel free-look on the focus key's OWN transition to non-null —
        // NOT unconditionally whenever `battlerPos` resolves, which would
        // kill free-look on every single frame a battler focus happens to
        // be live (fighting a drag gesture that re-engages it the very next
        // frame). This is the subagent-card-click equivalent of `applyState`
        // canceling free-look on a `selectedId` change above — needed
        // because a click whose parent is already selected never trips that
        // check (see `lastFocusBattlerKey`'s own comment).
        if (focusBattlerKey !== lastFocusBattlerKey) {
          lastFocusBattlerKey = focusBattlerKey;
          if (focusBattlerKey) camera.setFreeLook(false);
        }
        // Free-look (a drag/wheel gesture, or a click on empty ground) owns
        // the camera until the next selection change — skip both automatic
        // paths below while it's active, or a gesture would be overridden
        // the very next frame.
        if (!camera.isFreeLook()) {
          // `walker.worldX/worldY` are local to `content` (the map's own
          // untranslated coordinate space) — `camera` positions `world`
          // itself, so a focus target needs the same `borderPx` offset
          // `content` was given above to land on the walker's actual on-
          // screen position instead of drifting by one border thickness.
          if (battlerPos) camera.focusOn(battlerPos.x + borderPx, battlerPos.y - 12 + borderPx, 2.4);
          else if (focus) camera.focusOn(focus.walker.worldX + borderPx, focus.walker.worldY - 12 + borderPx, 2.4);
          else camera.fitToScreen();
        }
        camera.update();
        } catch (e) {
          console.error('[garden] ticker threw — skipping this frame:', e);
          if (!loggedTickerThrow) {
            loggedTickerThrow = true;
            safeLogDiagnostic('garden', 'error', 'garden ticker threw outside battle isolation — skipping this frame', {
              error: e instanceof Error ? (e.stack ?? e.message) : String(e)
            });
          }
        }
      });

      const ro = new ResizeObserver(syncCanvasToHost);
      ro.observe(host);

      // Fires the one real resize `syncCanvasToHost` skipped for the whole
      // drag, the instant GardenSplitHandle.tsx's stopDragging reports the
      // drag over. rAF-deferred: that event fires right after
      // `setGardenSplit(..., true)` commits the final drawer width, but
      // React's own re-render/layout from that commit isn't guaranteed to
      // have landed yet — one frame later it's settled either way. If the
      // drag's last rAF tick already left the layout at its final size (the
      // common case), this is the only resize call the whole drag produces.
      const onSplitDragEnd = (): void => {
        requestAnimationFrame(() => {
          if (!destroyed) syncCanvasToHost();
        });
      };
      window.addEventListener(GARDEN_SPLIT_DRAG_END_EVENT, onSplitDragEnd);

      cleanup = (): void => {
        ro.disconnect();
        window.removeEventListener(GARDEN_SPLIT_DRAG_END_EVENT, onSplitDragEnd);
        canvas.removeEventListener?.('webglcontextlost', onContextLost);
        canvas.removeEventListener?.('webglcontextrestored', onContextRestored);
        if (contextRestoreTimer) clearTimeout(contextRestoreTimer);
        world.off('pointerdown', onWorldPointerDown);
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
        canvas.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKeyDown);
        unsubscribe();
        unsubscribeWorkspace();
        offRitual();
        for (const id of [...runtimes.keys()]) removeWalker(id);
        battleManager.dispose();
        clearBattleFx();
        gardenCharm.destroy();
        dayNight.destroy();
        app.destroy(true, { children: true });
      };
    };

    await init();
    };

    void mountScene();

    return () => {
      currentCleanup?.();
    };
  }, []);

  // The map is the game screen; this pane is its console shell. `.garden-mat`
  // is the lifted bezel (margin + border); `.garden-warp-frame` is its
  // clipped interior — `.garden` (the Pixi host) plus `ArceusWarp`'s layers
  // are stacked full-size panes; ArceusWarp.tsx drives them all via a
  // single JS progress value, not a CSS class, so the warp can reverse
  // mid-flight — the simulation inside `.garden` keeps running the whole
  // time it's warped away.
  // `.garden-frame-shadow` is a plain absolutely-positioned sibling of the
  // canvas (appended imperatively, below) — being positioned, it always
  // paints above the non-positioned canvas regardless of DOM order, which is
  // what lets an inset shadow show up ON TOP of the map instead of being
  // painted underneath it.
  return (
    <div className="garden-mat">
      <div className="garden-warp-frame">
        <div className="garden" ref={hostRef}>
          <div className="garden-frame-shadow" />
        </div>
        <ArceusWarp hostRef={hostRef} ascended={ascended} />
        {crashed && (
          // Auto-rebuild attempt cap hit (garden-ui-crash triage,
          // 2026-08-29) — same "log it, offer a manual way out" idiom as
          // ErrorBoundary.tsx's own render-error fallback, just scoped to
          // this one pane instead of the whole app. The Pixi host's own
          // canvas is already gone at this point (the last rebuild's
          // cleanup destroyed it with `removeView`), so this just needs to
          // fill the space it left.
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              color: '#ddd',
              background: '#1a1a1a',
              fontFamily: 'system-ui, sans-serif'
            }}
          >
            <p>garden crashed — click to rebuild</p>
            <button type="button" onClick={() => manualRebuildRef.current()}>
              rebuild
            </button>
          </div>
        )}
      </div>
      <div className={ritualActive ? 'garden-sunset-overlay active' : 'garden-sunset-overlay'} aria-hidden="true" />
    </div>
  );
}
