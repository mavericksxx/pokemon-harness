import type { CSSProperties } from 'react';
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GRID_COLUMNS,
  GRID_ROWS,
  SHEET_URLS
} from '@/scene/garden/pokemonArt';

/**
 * One Pokemon's down-facing idle frame, as a DOM element.
 *
 * The garden draws its walkers through Pixi; the picker and the session pills
 * are plain DOM, so they crop the same sheet with `background-position` instead.
 * `background-size` scales the WHOLE sheet, hence the grid multipliers.
 */

/** Empty pixels above the art inside a frame — 4..15px across the twelve
 *  sheets. Hiding six of them keeps the face filling its box without clipping
 *  the tallest sprite (Snorlax). */
const HEAD_ROOM = 6;

interface Props {
  name: string;
  /** Pixel scale. 1 renders the sheet at its native 32px frame. */
  scale?: number;
}

export function PokemonFace({ name, scale = 1.5 }: Props): JSX.Element {
  const url = SHEET_URLS[name];
  const style: CSSProperties = {
    backgroundImage: url ? `url(${url})` : undefined,
    backgroundSize: `${FRAME_WIDTH * GRID_COLUMNS * scale}px ${FRAME_HEIGHT * GRID_ROWS * scale}px`,
    // Row 0, column 0: the down-facing idle frame.
    backgroundPosition: `0 -${HEAD_ROOM * scale}px`,
    width: FRAME_WIDTH * scale,
    height: (FRAME_HEIGHT - HEAD_ROOM) * scale
  };
  return <i className="pokemon-face" style={style} aria-hidden />;
}
