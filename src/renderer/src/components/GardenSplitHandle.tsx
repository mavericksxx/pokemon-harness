import { useEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import {
  DEFAULT_GARDEN_SPLIT,
  GARDEN_MIN_PX,
  GARDEN_SPLIT_DRAG_END_EVENT,
  HANDLE_PX,
  TERMINAL_MIN_PX
} from '@/gardenSplit';

const DRAG_THRESHOLD_PX = 4;

/** Magnetic snap radius for the true-50/50 point, in px of drawer width —
 *  not a ratio delta, so the feel is identical on a cramped and a huge
 *  window instead of the same ratio delta meaning a hair-trigger snap on a
 *  wide row and an unreachable one on a narrow row. 10px is small enough
 *  that nudging the handle a centimeter past center still tracks the
 *  cursor normally (this is a "wants to rest here" pull, not a dead zone
 *  the user has to fight through), but comfortably bigger than a stray
 *  trackpad jitter, so it reads as "the handle found the middle" rather
 *  than an accidental snap. */
const CENTER_SNAP_PX = 10;

/** Draggable divider between the garden and the terminal drawer, mounted by
 *  App.tsx between them in `.body-row` only in 'garden' view mode with the
 *  drawer open (the one layout with a split at all — 'terminal'/
 *  'gardenFull' fill the whole row with one pane).
 *
 *  Pointer events, not HTML5 drag (`setPointerCapture` keeps every move
 *  routed here even if the cursor leaves the 16px transparent hit zone mid-drag — no
 *  separate dragover plumbing needed). The row's width is measured once on
 *  pointerdown, not every move: it doesn't change mid-drag (the user isn't
 *  also resizing the OS window at the same instant), so re-measuring every
 *  move would just be a wasted layout read. `grabOffsetRef` (also captured
 *  on pointerdown) is the cursor's offset from the handle's own left edge
 *  at grab time, so the handle tracks the cursor exactly from wherever in
 *  its hit area the user grabbed it, instead of jumping to align its
 *  right edge with the cursor on the first move.
 *
 *  Width updates are rAF-throttled (`latestXRef` always holds the newest
 *  pointer position; a queued frame reads it once) rather than applied on
 *  every raw pointermove — dragging changes `.drawer`'s width every tick,
 *  which both GardenScene's ResizeObserver (Pixi canvas resize) and
 *  terminalRegistry's (xterm fit + a resizePty IPC call) are watching, so
 *  this caps how often either fires to once per animation frame instead of
 *  once per raw input event (which can outpace 60fps on a fast trackpad).
 *  This only re-renders TerminalDrawer (the sole other selector of
 *  `gardenSplit`) — its terminal-attach effect is keyed on `[open,
 *  selectedId]`, not the split, so a drag never re-attaches the terminal or
 *  touches its WebGL context. Live ticks pass `persist: false` to the
 *  store — only pointerup/double-click bank the ratio to localStorage, so a
 *  drag doesn't hit disk every frame. */
export function GardenSplitHandle(): JSX.Element {
  const setGardenSplit = useStore((s) => s.setGardenSplit);
  const draggingRef = useRef(false);
  const rowRectRef = useRef<DOMRect | null>(null);
  // The party rail's live rendered width (0 once split-inactive edge cases
  // are excluded by App.tsx never mounting this handle in 'gardenFull') —
  // captured alongside rowRectRef on pointerdown rather than hardcoded to
  // PARTY_RAIL_PX, because the rail collapses to 56px below ~1100px
  // (index.css's "Collapsed rail" block) and "50/50" has to mean the
  // midpoint of the garden+terminal area alone, not 50% of the whole row
  // (which would silently shift off-center by however wide the rail
  // currently is).
  const railWidthRef = useRef(0);
  const grabOffsetRef = useRef(0);
  const downXRef = useRef(0);
  const latestXRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // A bare click (pointerdown → pointerup, no move) must not overwrite the
  // stored ratio with the drawer's current *laid-out* width — normally a
  // no-op, but below ~806px of row width the two clamp() floors overlap
  // (terminal holds 420px even though that leaves the garden under its own
  // 380px floor), and persisting that already-clamped width would silently
  // narrow the user's actual saved preference.
  const movedRef = useRef(false);

  /** Garden's fraction of the row for pointer position `clientX`, clamped
   *  to both floors — the one calculation both the rAF tick and
   *  pointerup's final commit use, so releasing the pointer never persists
   *  a stale, pre-last-move ratio (see the rAF-cancel in stopDragging).
   *
   *  Also where the magnetic 50/50 snap lives, so it applies identically to
   *  every live drag tick and the final pointerup commit for free, instead
   *  of needing a parallel code path. `rowRect` is the whole `.body-row`
   *  (party rail included, see onPointerDown), so true center of the
   *  garden+terminal area alone is computed the same way `terminalWidthCss`
   *  reasons about drawer width: the garden+terminal area is
   *  `rowRect.width - railWidthRef.current` wide, split evenly around the
   *  handle means each side gets half of what's left after the handle's
   *  own width comes out. */
  const ratioFor = (clientX: number): number => {
    const rowRect = rowRectRef.current;
    if (!rowRect) return useStore.getState().gardenSplit;
    const handleLeft = clientX - grabOffsetRef.current;
    const drawerWidth = rowRect.right - (handleLeft + HANDLE_PX);
    const maxDrawerWidth = Math.max(TERMINAL_MIN_PX, rowRect.width - HANDLE_PX - GARDEN_MIN_PX);
    const clampedDrawerWidth = Math.min(Math.max(drawerWidth, TERMINAL_MIN_PX), maxDrawerWidth);
    // True-center drawer width sits inside [TERMINAL_MIN_PX,
    // maxDrawerWidth] for basically every real row width — center >=
    // TERMINAL_MIN_PX needs rowRect.width >= 2*TERMINAL_MIN_PX + HANDLE_PX +
    // railWidth, which the split-active threshold (NARROW_LAYOUT_MAX_PX,
    // ~1020px) only clears with the rail already collapsed to 56px (its own
    // ~1100px breakpoint in index.css) — two constants tuned independently,
    // not one derived from the other, so the clamp below is cheap insurance
    // rather than provably dead code if either one ever drifts.
    const centerDrawerWidth = Math.min(
      Math.max((rowRect.width - railWidthRef.current - HANDLE_PX) / 2, TERMINAL_MIN_PX),
      maxDrawerWidth
    );
    const snappedDrawerWidth =
      Math.abs(clampedDrawerWidth - centerDrawerWidth) <= CENTER_SNAP_PX
        ? centerDrawerWidth
        : clampedDrawerWidth;
    return 1 - snappedDrawerWidth / rowRect.width;
  };

  const stopDragging = (persistRatio: boolean): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove('is-splitting');
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (persistRatio && movedRef.current) setGardenSplit(ratioFor(latestXRef.current), true);
    // GardenScene.tsx and terminalRegistry.ts both sat out this drag's own
    // resize work (see GARDEN_SPLIT_DRAG_END_EVENT's comment) — this is
    // their cue to do the one real resize/fit it actually needs.
    window.dispatchEvent(new Event(GARDEN_SPLIT_DRAG_END_EVENT));
  };

  // Belt-and-braces: if this unmounts mid-drag (e.g. a keyboard shortcut
  // flips view mode while the pointer is still down), don't leave the
  // no-select/no-canvas-pointer-events class stuck on <body> or a stray
  // rAF pending.
  useEffect(() => () => stopDragging(false), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const row = e.currentTarget.parentElement;
    if (!row) return;
    rowRectRef.current = row.getBoundingClientRect();
    // The rail is always `.body-row`'s first child whenever this handle is
    // mounted (both require 'garden'/'terminal' view mode — see App.tsx's
    // `showRosterRail` and `splitActive`) — the `?? 0` fallback is only for
    // the unreachable case of this handle somehow mounting without it.
    railWidthRef.current = row.querySelector('.party-rail')?.getBoundingClientRect().width ?? 0;
    grabOffsetRef.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
    downXRef.current = e.clientX;
    latestXRef.current = e.clientX;
    draggingRef.current = true;
    movedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('is-splitting');
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    latestXRef.current = e.clientX;
    // Let a small amount of pointer drift still count as a bare click. Once
    // the divider has moved past the threshold, keep treating the whole
    // pointer session as a drag even if it later settles back near its
    // start point.
    if (!movedRef.current) {
      if (Math.abs(e.clientX - downXRef.current) < DRAG_THRESHOLD_PX) return;
      movedRef.current = true;
    }
    if (rafRef.current != null) return; // a frame is already queued — it'll read the latest X above
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setGardenSplit(ratioFor(latestXRef.current), false);
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    stopDragging(true);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released (e.g. pointercancel got there first) */
    }
  };

  return (
    <div
      className="garden-split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="resize garden and terminal panes"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setGardenSplit(DEFAULT_GARDEN_SPLIT, true)}
    >
      <span className="garden-split-line" aria-hidden="true" />
    </div>
  );
}
