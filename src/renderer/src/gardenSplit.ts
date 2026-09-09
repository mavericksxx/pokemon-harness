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

/** The party rail's (components/RosterStrip.tsx) fixed width at its normal
 *  (uncollapsed) size — a `.body-row` sibling of the garden/handle/drawer
 *  group below `NARROW_LAYOUT_MAX_PX`'s old formula never accounted for, see
 *  that constant's own comment. index.css's own rail-width rules are the
 *  source of truth for the actual rendered box (56px once the rail itself
 *  collapses, see its "party rail" section); this is only read here to keep
 *  the narrow-layout threshold honest against the WORST case (rail still at
 *  its full width). */
export const PARTY_RAIL_PX = 200;

/** Row width below which the garden/terminal split stops being structurally
 *  valid: `TERMINAL_MIN_PX + GARDEN_MIN_PX + HANDLE_PX` (806px) is the exact
 *  point the two floors above start fighting each other (see
 *  GardenSplitHandle.tsx's `movedRef` comment for that pre-existing, until
 *  now unreachable-below-the-old-900px-window-floor bug) — plus a small
 *  slack margin so the collapse (effectiveLayout.ts) kicks in just before
 *  the fight starts, not exactly at the edge where clamp() is already
 *  producing a squeezed, half-collapsed split for one frame. Landing around
 *  820px, before the party rail existed.
 *
 *  Party-rail trap: the rail (App.tsx's `.body-row`) is now ANOTHER fixed-
 *  width sibling eating into the same row this threshold budgets against —
 *  without `PARTY_RAIL_PX` folded in here, the two floors above could start
 *  fighting at a row width up to 200px wider than this constant would
 *  admit, while `effectiveLayout.ts` still reported the split as valid.
 *  Using the rail's full (uncollapsed) width rather than its 56px collapsed
 *  one is deliberately the conservative choice — the rail's own collapse
 *  breakpoint (index.css, ~1100px) sits comfortably above the threshold this
 *  produces, so by the time a window is ever narrow enough for this to
 *  matter, the rail has already shrunk to 56px and there's slack to spare.
 *  Driven off these constants rather than picked freestanding so a future
 *  change to any floor keeps this threshold honest. */
export const NARROW_LAYOUT_MAX_PX = TERMINAL_MIN_PX + GARDEN_MIN_PX + HANDLE_PX + PARTY_RAIL_PX + 14;

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
