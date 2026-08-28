import { useEffect, useRef, useState } from 'react';
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
import { GardenCharm } from './gardenCharm';
import { ClosingRitual } from './ClosingRitual';
import { emitClosingRitualSignal, onClosingRitualSignal } from './closingRitualBus';
import { clearBattleFx, spawnShinySparkle } from './battle/battleFx';
import { playSpawnCry, playSelectCry } from '@/audio/audioEngine';
import { ArceusAscent } from '@/components/ArceusAscent';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
// The map keeps its Tiled `.tmj` extension so a real Tiled export can be dropped
// in verbatim; Vite has no JSON loader for that extension, hence `?raw` + parse.
import gardenMapRaw from './maps/garden.tmj?raw';
import { useStore, type Session } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import type { StationKind } from '@shared/types';
import { ground, hexToNumber } from '@/design/tokens';

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
  // Closing-time sunset overlay (Phase 8.5 Wave B item 2) — a CSS layer on
  // `.garden-mat` (not a Pixi layer: it needs to cover the whole mat,
  // including the letterbox, and mustn't scale with the camera or be
  // crushed by an in-flight evolution ceremony's own dim overlay). Plain
  // React state is fine here even though the rest of this component is
  // imperative Pixi: this is the one piece of UI actually in the React tree
  // (see the JSX return below).
  const [ritualActive, setRitualActive] = useState(false);
  // The cosmos ascent (Phase 8.8 §4) — active exactly when Arceus is the
  // selected session. A pure derived value (no lifecycle to manage, unlike
  // `ritualActive` above), so it reads straight off the store rather than
  // being toggled from inside the imperative Pixi effect below — that
  // effect never needs to know about it at all: it's a CSS transform on
  // this component's own JSX, entirely separate from the simulation
  // running underneath (which keeps going, unaffected, while ascended).
  const ascended = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let destroyed = false;
    let cleanup: (() => void) | null = null;

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
      const upgradeIfLazy = (session: Session, walker: Walker, rt: Runtime): void => {
        if (!session.shiny && pokemonAnimations.has(session.pokemon)) return;
        void loadLazyAnimation(session.pokemon, session.shiny).then((anim) => {
          if (runtimes.get(session.id) !== rt) return; // session gone/replaced meanwhile
          if (anim) {
            walker.setAnimation(anim);
          } else {
            const label = speciesEntry(session.pokemon)?.name ?? session.pokemon;
            useStore.getState().pushToast(`couldn't load ${label}'s sprite — offline or not found.`);
          }
          if (session.shiny) {
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
            useStore.getState().pushToast(`couldn't load ${label}'s sprite — evolving with a placeholder.`);
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
        // clicking the walker itself (Walker's onClick just calls `select`)
        // — reconciles through here, so this is the single choke point for
        // both. `playSelectCry` debounces on its own; the null-check means
        // deselecting plays nothing.
        if (selectedId !== lastSelectedId) {
          lastSelectedId = selectedId;
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

          // A battling parent owns its own walker's position/facing for the
          // duration (approach/faceoff/attack loop) — the normal station
          // reconcile stands down until BattleManager hands it back via
          // onBattleEnd, which resets lastStation so this picks up again. A
          // napping walker owns its own position the same way — it stays
          // parked until it wakes.
          if (!battleManager.isBattling(session.id) && !walker.isNapping) {
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

          const toolKey = `${session.status}|${session.tool ?? ''}|${session.toolTarget ?? ''}|${session.looping ? 1 : 0}|${!!session.napping}`;
          if (toolKey !== rt.lastToolKey) {
            rt.lastToolKey = toolKey;
            if (session.looping) {
              walker.showText('looping');
            } else if (session.napping) {
              walker.hideBubble();
            } else if (session.status === 'working' && session.tool) {
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
      // Workspace switches (Phase 8.7) don't touch the session store at all
      // — subscribing here too is what makes a switch itself re-run the
      // visibility pass (and the full per-session reconcile for whichever
      // workspace just became active, catching it up on anything that
      // changed while it was hidden) instead of waiting for the next
      // unrelated session-store change.
      const unsubscribeWorkspace = useWorkspaceStore.subscribe(applyState);
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
        closingRitual.update(dt);

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

        const selectedId = useStore.getState().selectedId;
        const focus = selectedId ? runtimes.get(selectedId) : undefined;
        if (focus) camera.focusOn(focus.walker.worldX, focus.walker.worldY - 12, 2.4);
        else camera.fitToScreen();
        camera.update();
      });

      const ro = new ResizeObserver(syncCanvasToHost);
      ro.observe(host);

      cleanup = (): void => {
        ro.disconnect();
        unsubscribe();
        unsubscribeWorkspace();
        offRitual();
        for (const id of [...runtimes.keys()]) removeWalker(id);
        battleManager.dispose();
        clearBattleFx();
        gardenCharm.destroy();
        app.destroy(true, { children: true });
      };
    };

    void init();

    return () => {
      destroyed = true;
      cleanup?.();
    };
  }, []);

  // The map is the game screen; this pane is its console shell. `.garden-mat`
  // is the lifted bezel (margin + border); `.garden-ascent-frame` is its
  // clipped interior (Phase 8.8 §4 — `.garden` (the Pixi host) plus
  // `ArceusAscent`'s two layers are three stacked full-size panes;
  // ArceusAscent.tsx drives all three's transform/opacity directly via a
  // single JS progress value, not a CSS class, so the three-phase liftoff/
  // rush/arrival sequence can reverse mid-flight — the simulation inside
  // `.garden` keeps running the whole time it's off-screen).
  // `.garden-frame-shadow` is a plain absolutely-positioned sibling of the
  // canvas (appended imperatively, below) — being positioned, it always
  // paints above the non-positioned canvas regardless of DOM order, which is
  // what lets an inset shadow show up ON TOP of the map instead of being
  // painted underneath it.
  return (
    <div className="garden-mat">
      <div className="garden-ascent-frame">
        <div className="garden" ref={hostRef}>
          <div className="garden-frame-shadow" />
        </div>
        <ArceusAscent hostRef={hostRef} ascended={ascended} />
      </div>
      <div className={ritualActive ? 'garden-sunset-overlay active' : 'garden-sunset-overlay'} aria-hidden="true" />
    </div>
  );
}
