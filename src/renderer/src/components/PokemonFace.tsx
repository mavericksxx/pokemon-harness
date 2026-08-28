import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { POKEMON_ROSTER } from '@/scene/garden/showdownArt';
import { loadLazyThumbnail } from '@/scene/garden/lazySprites';

/**
 * One Pokemon's first animation frame, as a DOM element.
 *
 * The garden draws its walkers through Pixi; the picker and the session pills
 * are plain DOM, so they crop the same horizontal sheet with CSS instead.
 * `background-size` scales the WHOLE strip, so the width multiplier is the frame
 * count — here expressed as "make one frame `box` px wide".
 *
 * `name` may be any of the full 649-species dex, not just the 42 bundled: a
 * session's current stage, or a picker search result, can be a lazily-fetched
 * species (Phase 3 §2). Bundled species render instantly from the strip
 * already in memory; everything else fetches (and caches) a single-frame
 * thumbnail on demand and shows a pokeball placeholder until it resolves.
 *
 * `shiny` (Phase 5 §4): bundled species have no local shiny sheet, so a
 * shiny face ALWAYS goes through the lazy-thumbnail path, even for one of
 * the 42 bundled species — same rule as the garden's own walker art (see
 * GardenScene's `resolveAnimation`).
 */

/** Rendered size of the box, in CSS px. Sheets are ~96px, so this is a
 *  nearest-neighbour downscale; every species uses the same box so the grid
 *  stays even whatever the source frames measure. */
const DEFAULT_BOX = 44;

interface Props {
  name: string;
  box?: number;
  /** Show the shiny variant. Forces the lazy-thumbnail path — see this
   *  file's header. */
  shiny?: boolean;
}

export function PokemonFace({ name, box = DEFAULT_BOX, shiny = false }: Props): JSX.Element {
  const bundled = shiny ? undefined : POKEMON_ROSTER.find((p) => p.name === name);
  const [lazyUrl, setLazyUrl] = useState<string | null>(null);

  useEffect(() => {
    if (bundled) return;
    setLazyUrl(null);
    let cancelled = false;
    loadLazyThumbnail(name, shiny).then((url) => {
      if (!cancelled) setLazyUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [name, bundled, shiny]);

  if (bundled) {
    const style: CSSProperties = {
      backgroundImage: `url(${bundled.sheetUrl})`,
      // Scale so one frame is `box` wide; the strip is many frames long.
      backgroundSize: `auto ${(box / bundled.frameWidth) * bundled.frameHeight}px`,
      backgroundPosition: 'left top',
      width: box,
      height: (box / bundled.frameWidth) * bundled.frameHeight
    };
    return <i className="pokemon-face" style={style} aria-hidden />;
  }

  if (lazyUrl) {
    const style: CSSProperties = {
      backgroundImage: `url(${lazyUrl})`,
      backgroundSize: 'contain',
      backgroundPosition: 'center',
      width: box,
      height: box
    };
    return <i className="pokemon-face" style={style} aria-hidden />;
  }

  return <i className="pokemon-face loading" style={{ width: box, height: box }} aria-hidden />;
}
