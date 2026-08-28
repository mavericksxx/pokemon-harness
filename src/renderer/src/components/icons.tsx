/**
 * Hand-drawn pixel-art chrome icons (ship-cut item 7: emoji purge — "I don't
 * want emojis anywhere in the app"). 16px grid (viewBox 0 0 16 16), single
 * `currentColor` fill so each icon inherits its button's text color and
 * theme automatically, `shapeRendering="crispEdges"` so the blocky pixel
 * shapes don't get anti-aliased into a blur at this size — same visual
 * language as the rest of the chrome (Press Start 2P, hard-edged panels).
 *
 * Each one replaces a specific emoji sighting from the sweep (grepped for
 * `\p{Extended_Pictographic}` across src/renderer and src/main, plus the
 * known list called out in the ship-cut brief): the view-mode switcher's
 * tree glyph, the quick-mute speaker, and the roster card's "looping"
 * badge. Monochrome symbol glyphs that already default to TEXT (not color
 * emoji) presentation — ☰ ⛶ ▣ in the view-mode switcher, ⚙ ⏮ ▶ ⏸ ⏭ in
 * settings/topbar, ✦ on the arceus chip, ★ on the shiny badge — are left as
 * plain characters; verified against rendered screenshots, not source,
 * same standard this file's own icons need to clear.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function PixelIcon({ children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** View-mode switcher's "Garden" mode — was U+1F332 EVERGREEN TREE. */
export function TreeIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="7" y="1" width="2" height="1" />
      <rect x="6" y="2" width="4" height="1" />
      <rect x="6" y="3" width="4" height="1" />
      <rect x="5" y="4" width="6" height="1" />
      <rect x="4" y="5" width="8" height="1" />
      <rect x="5" y="6" width="6" height="1" />
      <rect x="3" y="7" width="10" height="1" />
      <rect x="2" y="8" width="12" height="1" />
      <rect x="4" y="9" width="8" height="1" />
      <rect x="7" y="10" width="2" height="4" />
    </PixelIcon>
  );
}

/** Delete-workspace button — was U+1F5D1 WASTEBASKET. */
export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="6" y="1" width="4" height="1" />
      <rect x="3" y="3" width="10" height="1" />
      <rect x="4" y="4" width="1" height="10" />
      <rect x="11" y="4" width="1" height="10" />
      <rect x="4" y="13" width="8" height="1" />
      <rect x="6" y="6" width="1" height="6" />
      <rect x="9" y="6" width="1" height="6" />
    </PixelIcon>
  );
}

/** Loop-detector "looping" badge — was U+1F4AB DIZZY (a swirl of motion
 *  lines). Drawn as a broken ring with an arrowhead, the standard "sync /
 *  repeat" silhouette, so it still reads as "going in circles" rather than
 *  a generic spinner. */
export function LoopIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="5" y="2" width="6" height="2" />
      <rect x="2" y="4" width="2" height="7" />
      <rect x="4" y="10" width="2" height="2" />
      <rect x="6" y="12" width="5" height="2" />
      <rect x="11" y="4" width="2" height="4" />
      <polygon points="10,3 14,5 10,7" />
    </PixelIcon>
  );
}

/** Roster card's "change pokemon" affordance — two opposing arrows, the
 *  standard exchange/swap silhouette, distinct from LoopIcon's single
 *  broken-ring "repeat" shape above. */
export function SwapIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="2" y="3" width="8" height="2" />
      <polygon points="10,2 14,4 10,6" />
      <rect x="6" y="9" width="8" height="2" />
      <polygon points="6,8 2,10 6,12" />
    </PixelIcon>
  );
}

/** Quick-mute chrome control's three states — were U+1F507/1F509/1F50A
 *  (muted/low/high speaker). Shared cone shape; the sound-wave arcs are the
 *  only difference between states. */
function SpeakerCone(): JSX.Element {
  return (
    <>
      <rect x="1" y="6" width="3" height="4" />
      <rect x="4" y="5" width="2" height="6" />
      <rect x="6" y="3" width="2" height="10" />
    </>
  );
}

export function SpeakerMuteIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <SpeakerCone />
      <rect x="10" y="6" width="1" height="1" />
      <rect x="11" y="7" width="1" height="1" />
      <rect x="12" y="8" width="1" height="1" />
      <rect x="11" y="9" width="1" height="1" />
      <rect x="10" y="10" width="1" height="1" />
      <rect x="12" y="6" width="1" height="1" />
      <rect x="13" y="7" width="1" height="1" />
      <rect x="13" y="9" width="1" height="1" />
      <rect x="12" y="10" width="1" height="1" />
    </PixelIcon>
  );
}

export function SpeakerLowIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <SpeakerCone />
      <rect x="10" y="6" width="1" height="4" />
      <rect x="11" y="7" width="1" height="2" />
    </PixelIcon>
  );
}

export function SpeakerHighIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <SpeakerCone />
      <rect x="10" y="6" width="1" height="4" />
      <rect x="11" y="5" width="1" height="6" />
      <rect x="12" y="4" width="1" height="8" />
    </PixelIcon>
  );
}

/** Topbar theme toggle's "switch to dark mode" state — a square disc (this
 *  app draws no circles anywhere; hard-edged rects match the rest of the
 *  chrome) with eight short rays. */
export function SunIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="5" y="5" width="6" height="6" />
      <rect x="7" y="1" width="2" height="2" />
      <rect x="7" y="13" width="2" height="2" />
      <rect x="1" y="7" width="2" height="2" />
      <rect x="13" y="7" width="2" height="2" />
      <rect x="3" y="3" width="2" height="2" />
      <rect x="11" y="3" width="2" height="2" />
      <rect x="3" y="11" width="2" height="2" />
      <rect x="11" y="11" width="2" height="2" />
    </PixelIcon>
  );
}

/** Quick-settings topbar trigger — three horizontal sliders at staggered
 *  offsets, the standard "quick settings" silhouette, drawn hard-edged to
 *  match the rest of this file rather than pulled in as a generic icon
 *  font glyph. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="1" y="2" width="14" height="1" />
      <rect x="9" y="1" width="2" height="3" />
      <rect x="1" y="7" width="14" height="1" />
      <rect x="4" y="6" width="2" height="3" />
      <rect x="1" y="12" width="14" height="1" />
      <rect x="10" y="11" width="2" height="3" />
    </PixelIcon>
  );
}

/** View-mode group's terminal-panel toggle (parity sweep — folded in from a
 *  plain "show/hide terminal" text button) — an outlined panel with a small
 *  ">" prompt and cursor line, same "thin rects for edges" technique as
 *  TrashIcon's outline. */
export function TerminalPanelIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="2" y="2" width="12" height="1" />
      <rect x="2" y="13" width="12" height="1" />
      <rect x="2" y="2" width="1" height="11" />
      <rect x="13" y="2" width="1" height="11" />
      <rect x="4" y="6" width="1" height="1" />
      <rect x="5" y="7" width="1" height="1" />
      <rect x="4" y="8" width="1" height="1" />
      <rect x="6" y="9" width="4" height="1" />
    </PixelIcon>
  );
}

/** View-mode group's "all sessions" toggle (parity sweep — folded in from a
 *  plain "sessions" text button) — a 2x2 grid of cards, the overview's own
 *  shape in miniature. */
export function SessionsIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </PixelIcon>
  );
}

/** Topbar theme toggle's "switch to light mode" state — a crescent, drawn as
 *  one filled blob with a second, offset blob's cells left out (rather than
 *  painted over) to cut the sliver. */
export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <PixelIcon {...props}>
      <rect x="6" y="2" width="3" height="1" />
      <rect x="5" y="3" width="3" height="1" />
      <rect x="4" y="4" width="3" height="1" />
      <rect x="4" y="5" width="3" height="1" />
      <rect x="3" y="6" width="3" height="1" />
      <rect x="3" y="7" width="3" height="1" />
      <rect x="3" y="8" width="4" height="1" />
      <rect x="3" y="9" width="4" height="1" />
      <rect x="4" y="10" width="4" height="1" />
      <rect x="4" y="11" width="5" height="1" />
      <rect x="5" y="12" width="4" height="1" />
      <rect x="6" y="13" width="4" height="1" />
    </PixelIcon>
  );
}
