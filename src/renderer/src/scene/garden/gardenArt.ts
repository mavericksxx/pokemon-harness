/**
 * The garden's real tileset art.
 *
 * SWAP SEAM (map side): returns one Pixi `Texture` per entry of
 * `maps/gardenTilesets.json`, in that file's order — which is the order
 * `garden.tmj` writes its `tilesets` array in, because `tools/gen-garden-map.cjs`
 * reads the same file to do its gid arithmetic. So `textures[i]` always matches
 * `mapData.tilesets[i]`, and a new sheet is an edit to that one JSON file plus a
 * line in IMAGE_URLS below.
 *
 * Licences for these three sheets are in assets/ASSETS.md and assets/garden/sources.md.
 */
import { Assets, Texture } from 'pixi.js';
import tilesetSpec from './maps/gardenTilesets.json';
import kenneyTinyTown from '@assets/garden/kenney_tiny_town.png';
import grasswaterPond from '@assets/garden/grasswater_pond_light.png';
import ogaMostlyFlowers from '@assets/garden/oga_mostly_flowers.png';

/** `image` path in gardenTilesets.json → the URL the bundler emitted for it. */
const IMAGE_URLS: Record<string, string> = {
  'garden/kenney_tiny_town.png': kenneyTinyTown,
  'garden/grasswater_pond_light.png': grasswaterPond,
  'garden/oga_mostly_flowers.png': ogaMostlyFlowers
};

export async function loadGardenTilesets(): Promise<Texture[]> {
  const urls = tilesetSpec.tilesets.map((t) => {
    const url = IMAGE_URLS[t.image];
    // Loud, because the quiet failure is a map that renders with the wrong gids.
    if (!url) throw new Error(`gardenTilesets.json lists ${t.image}, which has no import here`);
    return url;
  });
  const textures = await Promise.all(urls.map((url) => Assets.load<Texture>(url)));
  // Pixel art: nearest lives on the SOURCE, not the texture.
  for (const texture of textures) texture.source.scaleMode = 'nearest';
  return textures;
}
