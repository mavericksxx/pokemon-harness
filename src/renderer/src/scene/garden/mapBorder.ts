import { Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { TiledMap, TiledTilesetRef } from './TiledMapRenderer';

/**
 * Themed ring of tiles drawn just outside the map's own edge (Backlog item:
 * "themed borders" for the default garden map, extended so a future
 * per-map backdrop can supply its own). Deliberately an OVERLAY around the
 * map rather than baked into garden.tmj or its collision grid:
 * TiledMapRenderer's tile-index space (walkability, spawn points, zones,
 * pathfinding) never changes shape or size — this ring paints entirely
 * outside it. See GardenScene.tsx's own comment on how the ring and the
 * map's own content get positioned relative to each other (the map's fence
 * (`walls` layer, garden.tmj) already occupies the outermost non-walkable
 * ring; this border sits one more ring out, so it reads as "just past the
 * fence" rather than overlapping it).
 */
export interface MapBorderTile {
  /** Must match a `name` in the map's own `tilesets` array (garden.tmj). */
  tileset: string;
  /** 0-based, tileset-local tile id (same convention gen-garden-map.cjs's
   *  own `k()`/`f()` helpers use before adding a tileset's `firstgid`). */
  id: number;
}

export interface MapBorderConfig {
  /** Ring thickness, in tiles. */
  thickness: number;
  corner: MapBorderTile;
  edgeTop: MapBorderTile;
  edgeBottom: MapBorderTile;
  edgeSide: MapBorderTile;
}

/** Default garden's border — kenney_tiny_town's bush tile (id 5, the same
 *  gid `gen-garden-map.cjs` calls `BUSH`), reused for every edge and
 *  corner: it already tiles seamlessly in any direction, so one tile keeps
 *  this config trivial while still reading as a hedge line around the
 *  meadow. Two tiles thick, not one — the garden pane is usually seen at
 *  fit-to-screen zoom (Camera.fitToScreen), which can be well under 1x for
 *  a modest window, and a single 16px ring gets thin enough at that zoom to
 *  read as barely-there rather than a border; doubling it up is the cheap
 *  hedge against that without any extra config surface. A future backdrop
 *  just needs its own MapBorderConfig here. */
export const DEFAULT_GARDEN_BORDER: MapBorderConfig = {
  thickness: 2,
  corner: { tileset: 'kenney-tiny-town', id: 5 },
  edgeTop: { tileset: 'kenney-tiny-town', id: 5 },
  edgeBottom: { tileset: 'kenney-tiny-town', id: 5 },
  edgeSide: { tileset: 'kenney-tiny-town', id: 5 }
};

/** One tile's sub-rectangle of its tileset image, as a Texture — same slice
 *  math as TiledMapRenderer's own private `sliceTile` (no flip support
 *  needed here, so kept as its own small copy rather than exporting that
 *  private method just for this one caller). */
function sliceTile(tileset: TiledTilesetRef, sheet: Texture, localId: number, tileSize: number): Texture {
  const cols = tileset.columns ?? 16;
  const tw = tileset.tilewidth ?? tileSize;
  const th = tileset.tileheight ?? tileSize;
  const frame = new Rectangle((localId % cols) * tw, Math.floor(localId / cols) * th, tw, th);
  return new Texture({ source: sheet.source, frame });
}

function resolveTile(map: TiledMap, textures: Texture[], spec: MapBorderTile, tileSize: number): Texture | undefined {
  const i = map.tilesets.findIndex((t) => t.name === spec.tileset);
  if (i < 0 || !textures[i]) return undefined;
  return sliceTile(map.tilesets[i], textures[i], spec.id, tileSize);
}

/** Builds the border ring container, sized `config.thickness` tiles wider
 *  than the map on every side. Callers position this at local (0, 0) and
 *  the map's own content at local (thickness * tileSize, thickness *
 *  tileSize) — see GardenScene.tsx — so this ring's outer edge becomes the
 *  new total-drawable-area boundary Camera fits/clamps against. Returns an
 *  empty container (draws nothing) if `config`'s tileset names don't match
 *  the loaded map — a missing/renamed tileset shouldn't crash the garden
 *  over a decorative border. */
export function buildMapBorder(map: TiledMap, textures: Texture[], config: MapBorderConfig): Container {
  const container = new Container();
  container.label = 'map-border';

  const tileSize = map.tilewidth;
  const cornerTex = resolveTile(map, textures, config.corner, tileSize);
  const topTex = resolveTile(map, textures, config.edgeTop, tileSize);
  const bottomTex = resolveTile(map, textures, config.edgeBottom, tileSize);
  const sideTex = resolveTile(map, textures, config.edgeSide, tileSize);
  if (!cornerTex || !topTex || !bottomTex || !sideTex) return container;

  const t = config.thickness;
  const totalW = map.width + t * 2;
  const totalH = map.height + t * 2;

  const place = (col: number, row: number, texture: Texture): void => {
    const sprite = new Sprite(texture);
    sprite.x = col * tileSize;
    sprite.y = row * tileSize;
    container.addChild(sprite);
  };

  for (let ring = 0; ring < t; ring++) {
    for (let col = 0; col < totalW; col++) {
      place(col, ring, topTex);
      place(col, totalH - 1 - ring, bottomTex);
    }
    for (let row = t; row < totalH - t; row++) {
      place(ring, row, sideTex);
      place(totalW - 1 - ring, row, sideTex);
    }
  }
  // Corners drawn last (on top of the straight edges' own corner tiles) —
  // lets a future theme give corners distinct art without special-casing
  // the loops above.
  for (let ring = 0; ring < t; ring++) {
    place(ring, ring, cornerTex);
    place(totalW - 1 - ring, ring, cornerTex);
    place(ring, totalH - 1 - ring, cornerTex);
    place(totalW - 1 - ring, totalH - 1 - ring, cornerTex);
  }

  return container;
}
