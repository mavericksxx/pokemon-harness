import type { CSSProperties } from 'react';
import { POKEMON_ROSTER } from '@/scene/garden/showdownArt';

/**
 * One Pokemon's first animation frame, as a DOM element.
 *
 * The garden draws its walkers through Pixi; the picker and the session pills
 * are plain DOM, so they crop the same horizontal sheet with CSS instead.
 * `background-size` scales the WHOLE strip, so the width multiplier is the frame
 * count — here expressed as "make one frame `box` px wide".
 */

/** Rendered size of the box, in CSS px. Sheets are ~96px, so this is a
 *  nearest-neighbour downscale; every species uses the same box so the grid
 *  stays even whatever the source frames measure. */
const DEFAULT_BOX = 44;

interface Props {
  name: string;
  box?: number;
}

export function PokemonFace({ name, box = DEFAULT_BOX }: Props): JSX.Element {
  const info = POKEMON_ROSTER.find((p) => p.name === name);
  const style: CSSProperties = info
    ? {
        backgroundImage: `url(${info.sheetUrl})`,
        // Scale so one frame is `box` wide; the strip is many frames long.
        backgroundSize: `auto ${(box / info.frameWidth) * info.frameHeight}px`,
        backgroundPosition: 'left top',
        width: box,
        height: (box / info.frameWidth) * info.frameHeight
      }
    : { width: box, height: box };
  return <i className="pokemon-face" style={style} aria-hidden />;
}
