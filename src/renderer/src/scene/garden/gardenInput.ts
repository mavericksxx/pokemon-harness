import { Container, Rectangle } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import type { Camera } from './Camera';
import type { Runtime } from './walkerLifecycle';
import type { BattleManager } from './battle/BattleManager';
import type { AdvisorManager } from './battle/AdvisorManager';
import type { ViewMode } from '@/store/store';

/** Dependencies `attachGardenInput` needs from its owning `mountScene`
 *  generation. `battleManager`/`advisorManager` are passed as plain
 *  references rather than getters — unlike walkerLifecycle.ts's own
 *  `getBattleManager`, this module is wired up AFTER both managers are
 *  constructed (it replaces the spot the original click-resolution block
 *  occupied, right after `advisorManager`), so there's no forward reference
 *  to work around; both are stable `const`s for this generation's whole
 *  lifetime. `getViewMode`/`getSelectedId`/`setViewMode`/`select` mirror
 *  BattleDeps' own getter/callback convention for store access. */
export interface GardenInputCtx {
  canvas: HTMLCanvasElement;
  world: Container;
  charLayer: Container;
  camera: Camera;
  mapWidthPx: number;
  mapHeightPx: number;
  runtimes: Map<string, Runtime>;
  battleManager: BattleManager;
  advisorManager: AdvisorManager;
  getViewMode: () => ViewMode;
  getSelectedId: () => string | null;
  setViewMode: (mode: ViewMode) => void;
  select: (id: string | null) => void;
}

/** Pointer/drag/zoom/wheel/escape input plus the click hit-test correction
 *  pass — moved verbatim out of GardenScene.tsx's own effect body. Returns
 *  a single cleanup that detaches every listener this attaches, in the same
 *  relative order the original effect's own `cleanup()` removed them in. */
export function attachGardenInput(ctx: GardenInputCtx): () => void {
  const { canvas, world, charLayer, camera, mapWidthPx, mapHeightPx, runtimes, battleManager, advisorManager } = ctx;

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
      const viewMode = ctx.getViewMode();
      if (viewMode === 'garden') {
        ctx.setViewMode('gardenFull');
      } else if (viewMode === 'gardenFull') {
        // Breaks follow into free-look so the whole-map view isn't
        // immediately re-overridden by the selected-session camera.
        camera.setFreeLook(false);
        ctx.select(null);
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
  // entirely, so Escape there has nothing to do here.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    const viewMode = ctx.getViewMode();
    const selectedId = ctx.getSelectedId();
    if (viewMode !== 'garden' && viewMode !== 'gardenFull') return;
    // Nothing selected AND not free-looking means the view is already at
    // rest (fitToScreen) — nothing for Escape to do.
    if (selectedId == null && !camera.isFreeLook()) return;
    camera.setFreeLook(false);
    ctx.select(null);
  };
  window.addEventListener('keydown', onKeyDown);

  // Click-resolution fix (v1.8.0 bug report — a battler click jumping
  // to a DIFFERENT session's walker): both Walker and Battler give
  // their `container` an explicit rectangular `hitArea` sized off the
  // drawn sprite (generous — it covers transparent padding, not just
  // opaque pixels), and both are direct children of `charLayer`
  // (`sortableChildren = true`, zIndex = feet Y). Pixi's own
  // `EventBoundary.hitTestRecursive` walks `charLayer.children` highest-
  // zIndex-first and returns the FIRST container whose hitArea contains
  // the point — so whichever walker/battler happens to be "in front"
  // (bigger py) wins any overlap, even where its rectangle is empty air
  // and the point is actually over a DIFFERENT, smaller-zIndex sprite's
  // visible pixels standing just behind it. Battlers cluster near their
  // parent (`pickRoamHome`) and idle walkers cluster near their own
  // station, so this overlap is common with several sessions live.
  //
  // Fix: intercept every character click at `charLayer` during the
  // CAPTURE phase (before Pixi's own bubbling reaches whichever
  // container it picked). Only clicks Pixi ALREADY resolved to a
  // walker or battler are touched — `charLayer` also parents
  // GardenCharm's well/signpost hotspots (gardenCharm.ts's `well`/`hot`,
  // also charLayer descendants with their own hitArea/zIndex), and
  // those are left entirely alone so a walker overlapping a hotspot
  // can't steal ITS click the same way. For a walker/battler `e.target`,
  // independently re-test every walker and battler's own hitArea
  // against the same point and redispatch to whichever one's FEET are
  // nearest the click — not whichever Pixi's first-hit walk happened to
  // reach first. `event.getLocalPosition(candidate)` conveniently
  // returns the click in that candidate's own local space, i.e. exactly
  // its (dx, dy) offset from its own feet (`container.x/y`), so no
  // separate distance computation against a shared coordinate space is
  // needed. `charLayer.eventMode = 'static'` is required for it to
  // receive ANY event at all (`EventBoundary.notifyTarget` drops
  // ancestors that aren't interactive) but, since `charLayer` itself
  // has no `hitArea`/`containsPoint`, it never becomes a hit TARGET on
  // its own — existing background hit-testing is unchanged (bare ground
  // never reaches this handler at all: `world`'s own hitArea only
  // resolves once every `content`/`charLayer` descendant fails ITS OWN
  // test first).
  charLayer.eventMode = 'static';
  // A container Pixi itself would prune from hit-testing (hidden —
  // GardenScene's reconcile sets an inactive-workspace walker's
  // `container.visible = false`, and BattleManager.setVisible does the
  // same for that parent's battlers — or otherwise non-renderable/
  // non-interactive) must never win here: `hitTestRecursive`'s own
  // `_interactivePrune` (EventBoundary.mjs) already keeps such a
  // container from ever becoming `e.target`, but this manual re-scan
  // bypasses that pruning entirely unless it's re-applied itself. A
  // stale/hidden pokemon from another workspace could otherwise "win"
  // nearest-feet and get the redispatched click, selecting a session
  // from a garden the click never visually touched.
  const isClickable = (c: Container): boolean => c.visible && c.renderable && c.eventMode !== 'none';
  const resolveCharacterClick = (e: FederatedPointerEvent): void => {
    const candidates: Container[] = [];
    for (const rt of runtimes.values()) {
      if (isClickable(rt.walker.container)) candidates.push(rt.walker.container);
    }
    for (const candidate of battleManager.getClickCandidates()) {
      if (isClickable(candidate.container)) candidates.push(candidate.container);
    }
    for (const candidate of advisorManager.getClickCandidates()) {
      if (isClickable(candidate.container)) candidates.push(candidate.container);
    }
    if (!(e.target instanceof Container) || !candidates.includes(e.target)) return;
    let winner = e.target;
    const targetLocal = e.getLocalPosition(winner);
    let winnerDistSq = targetLocal.x * targetLocal.x + targetLocal.y * targetLocal.y;
    for (const container of candidates) {
      if (!container.hitArea) continue;
      const local = e.getLocalPosition(container);
      if (!container.hitArea.contains(local.x, local.y)) continue;
      const distSq = local.x * local.x + local.y * local.y;
      if (distSq < winnerDistSq) {
        winner = container;
        winnerDistSq = distSq;
      }
    }
    // Pixi's own pick was already the nearest-feet winner — nothing to
    // correct, leave normal propagation alone.
    if (winner === e.target) return;
    e.stopPropagation();
    winner.emit('pointertap', e);
  };
  charLayer.addEventListener('pointertap', resolveCharacterClick, { capture: true });

  return (): void => {
    world.off('pointerdown', onWorldPointerDown);
    charLayer.removeEventListener('pointertap', resolveCharacterClick, { capture: true });
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
  };
}
