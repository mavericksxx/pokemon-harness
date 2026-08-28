import { useEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { DEFAULT_GARDEN_SPLIT, GARDEN_MIN_PX, HANDLE_PX, TERMINAL_MIN_PX } from '@/gardenSplit';

/** Draggable divider between the garden and the terminal drawer, mounted by
 *  App.tsx between them in `.body-row` only in 'garden' view mode with the
 *  drawer open (the one layout with a split at all — 'terminal'/
 *  'gardenFull' fill the whole row with one pane).
 *
 *  Pointer events, not HTML5 drag (`setPointerCapture` keeps every move
 *  routed here even if the cursor leaves the 6px hit area mid-drag — no
 *  separate dragover plumbing needed). The row's width is measured once on
 *  pointerdown, not every move: it doesn't change mid-drag (the user isn't
 *  also resizing the OS window at the same instant), so re-measuring every
 *  move would just be a wasted layout read. `grabOffsetRef` (also captured
 *  on pointerdown) is the cursor's offset from the handle's own left edge
 *  at grab time, so the handle tracks the cursor exactly from wherever in
 *  its 6px hit area the user grabbed it, instead of jumping to align its
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
  const grabOffsetRef = useRef(0);
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
   *  a stale, pre-last-move ratio (see the rAF-cancel in stopDragging). */
  const ratioFor = (clientX: number): number => {
    const rowRect = rowRectRef.current;
    if (!rowRect) return useStore.getState().gardenSplit;
    const handleLeft = clientX - grabOffsetRef.current;
    const drawerWidth = rowRect.right - (handleLeft + HANDLE_PX);
    const maxDrawerWidth = Math.max(TERMINAL_MIN_PX, rowRect.width - HANDLE_PX - GARDEN_MIN_PX);
    const clampedDrawerWidth = Math.min(Math.max(drawerWidth, TERMINAL_MIN_PX), maxDrawerWidth);
    return 1 - clampedDrawerWidth / rowRect.width;
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
    grabOffsetRef.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
    latestXRef.current = e.clientX;
    draggingRef.current = true;
    movedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('is-splitting');
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    movedRef.current = true;
    latestXRef.current = e.clientX;
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
