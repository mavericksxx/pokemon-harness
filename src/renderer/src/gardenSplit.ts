/** Constants + math shared between the garden/terminal split's drag handle
 *  (components/GardenSplitHandle.tsx) and the drawer's own width
 *  (components/TerminalDrawer.tsx) — 'garden' view mode's side-by-side
 *  layout only (see App.tsx's `.body-row`). The persisted ratio itself
 *  lives in store.ts (`gardenSplit`/`setGardenSplit`), same pattern as
 *  `viewMode`. */

/** Terminal drawer never shrinks below this — narrower and even a modest
 *  xterm column count stops being useful. */
export const TERMINAL_MIN_PX = 420;

/** Garden pane never shrinks below this — smaller than its diorama frame
 *  (`.garden-mat`'s padding + border) can comfortably render. */
export const GARDEN_MIN_PX = 380;

/** Hit width of the drag handle itself (the visible line inside it is 2px,
 *  centered) — a fixed-width flex sibling between the garden and the
 *  drawer, so both mins above are computed against the row width MINUS
 *  this. */
export const HANDLE_PX = 6;

/** Default split — garden's fraction of the row, matching the old fixed
 *  46%/54% drawer/garden split this feature replaces. Also what a
 *  double-click on the handle resets to. */
export const DEFAULT_GARDEN_SPLIT = 0.54;

/** Dispatched on `window` by GardenSplitHandle.tsx the instant a drag ends
 *  (pointerup/pointercancel, or an early unmount mid-drag) — after
 *  `body.is-splitting` comes off. GardenScene.tsx and terminalRegistry.ts
 *  both skip their own real resize work (`renderer.resize` / xterm's
 *  `fit.fit()` + `resizePty`) for the whole drag — letting the drawer's
 *  CSS width change freely instead of reacting to every rAF-throttled tick
 *  is what stops the Pixi canvas from flickering and the two
 *  ResizeObservers from firing (and cascading into "loop completed with
 *  undelivered notifications" warnings) dozens of times a second — and both
 *  listen for this event to do the one real resize/fit the drag actually
 *  needs, once, after it settles. */
export const GARDEN_SPLIT_DRAG_END_EVENT = 'poke:garden-split-dragend';

/** The terminal drawer's CSS `width` for a given `ratio` (garden's fraction
 *  of the row): a `clamp()` between the two floors above, preferring the
 *  ratio's own percentage in between. Expressing it this way (rather than a
 *  plain percentage) means a window resize re-applies both floors for
 *  free — no resize listener of its own needed — the same way the drawer's
 *  old fixed `46%` already resolved against `.body-row`'s width. */
export function terminalWidthCss(ratio: number): string {
  const terminalPercent = (1 - ratio) * 100;
  return `clamp(${TERMINAL_MIN_PX}px, ${terminalPercent}%, calc(100% - ${GARDEN_MIN_PX + HANDLE_PX}px))`;
}
