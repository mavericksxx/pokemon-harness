import { Container, Sprite, Texture, Rectangle } from 'pixi.js';

// Ported from munder-difflin (src/renderer/src/scene/office/TiledMapRenderer.ts),
// itself a trimmed port of shahar061/the-office (office/engine/TiledMapRenderer.ts).
// Renders floor/walls/furniture tile layers and parses collision, spawn-points
// and zones. Only change from the upstream port: WALKABLE_SPAWN_PREFIXES is the
// garden's station vocabulary instead of the office's desk/pc names.

const FLIPPED_H_FLAG = 0x80000000;
const FLIPPED_V_FLAG = 0x40000000;
const FLIPPED_D_FLAG = 0x20000000;
const TILE_ID_MASK = 0x1fffffff;

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTilesetRef[];
}

export interface TiledLayer {
  name: string;
  type: string;
  data?: number[];
  objects?: TiledObject[];
}

export interface TiledObject {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface TiledTileAnimationFrame {
  tileid: number;
  duration: number;
}

export interface TiledTilesetTile {
  id: number;
  animation?: TiledTileAnimationFrame[];
}

export interface TiledTilesetRef {
  firstgid: number;
  source?: string;
  image?: string;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
  tiles?: TiledTilesetTile[];
}

/** Every sprite painted with one animated gid, plus that gid's frame textures.
 *  Grouped by gid rather than per sprite: the pond paints ~60 sprites from 11
 *  gids, and one shared Texture per (gid, frame) means a phase change is an
 *  assignment loop instead of an allocation storm. */
interface AnimatedTileGroup {
  textures: Texture[];
  durations: number[];
  sprites: Sprite[];
  elapsedMs: number;
  frame: number;
}

export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

const TILE_LAYERS = ['floor', 'walls', 'furniture-below', 'furniture-above'] as const;
const COLLISION_LAYER = 'collision';
const SPAWN_POINTS_LAYER = 'spawn-points';
const ZONES_LAYER = 'zones';

export class TiledMapRenderer {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** Tile sprites actually painted — logged at startup as the cheap "did the map
   *  render?" signal. Zero here means the gid/tileset wiring is wrong. */
  readonly tileSpriteCount: number = 0;

  private walkabilityGrid: boolean[][] = [];
  private spawnPoints: Map<string, Point> = new Map();
  private zones: Map<string, ZoneRect> = new Map();
  private characterContainer: Container;
  private rootContainer: Container;
  /** gid → its animation, for gids the map's tilesets declare `animation` on. */
  private animatedTiles: Map<number, AnimatedTileGroup> = new Map();

  /** Spawn points whose tile is forced walkable even if the art under them is
   *  solid — a walker must be able to path ONTO its station. findPath() returns
   *  null (silently) when the goal tile is blocked. */
  private static readonly WALKABLE_SPAWN_PREFIXES = [
    'patch-',
    'stump-',
    'pond-',
    'signpost-',
    'mailbox-',
    'wander-',
    'entrance'
  ];

  constructor(
    private mapData: TiledMap,
    private tilesetTextures: Texture[]
  ) {
    this.width = mapData.width;
    this.height = mapData.height;
    this.tileSize = mapData.tilewidth;
    this.rootContainer = new Container();
    this.characterContainer = new Container();
    this.characterContainer.sortableChildren = true;

    this.parseCollisionLayer();
    this.parseSpawnPoints();
    this.markWalkableSpawnPoints();
    this.parseZones();
    this.parseTileAnimations();
    this.tileSpriteCount = this.buildTileLayers();
  }

  /** Advance Tiled tile animations (the pond's water). Call once per frame. */
  update(deltaMs: number): void {
    for (const group of this.animatedTiles.values()) {
      if (group.sprites.length === 0) continue;
      group.elapsedMs += deltaMs;
      let advanced = false;
      while (group.elapsedMs >= group.durations[group.frame]) {
        group.elapsedMs -= group.durations[group.frame];
        group.frame = (group.frame + 1) % group.textures.length;
        advanced = true;
      }
      if (!advanced) continue;
      const texture = group.textures[group.frame];
      for (const sprite of group.sprites) sprite.texture = texture;
    }
  }

  getContainer(): Container {
    return this.rootContainer;
  }
  getCharacterContainer(): Container {
    return this.characterContainer;
  }

  isWalkable(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return this.walkabilityGrid[ty][tx];
  }

  tileToPixel(tx: number, ty: number): Point {
    return { x: tx * this.tileSize, y: ty * this.tileSize };
  }

  pixelToTile(px: number, py: number): Point {
    return { x: Math.floor(px / this.tileSize), y: Math.floor(py / this.tileSize) };
  }

  getSpawnPoint(name: string): Point | undefined {
    return this.spawnPoints.get(name);
  }
  getAllSpawnPoints(): Map<string, Point> {
    return this.spawnPoints;
  }
  getZone(name: string): ZoneRect | undefined {
    return this.zones.get(name);
  }
  getAllZones(): Map<string, ZoneRect> {
    return this.zones;
  }

  private parseCollisionLayer(): void {
    const layer = this.findLayer(COLLISION_LAYER, 'tilelayer');
    this.walkabilityGrid = Array.from({ length: this.height }, () => Array(this.width).fill(true));
    if (!layer?.data) return;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const rawId = layer.data[y * this.width + x];
        if ((rawId & TILE_ID_MASK) !== 0) this.walkabilityGrid[y][x] = false;
      }
    }
  }

  private parseSpawnPoints(): void {
    const layer = this.findLayer(SPAWN_POINTS_LAYER, 'objectgroup');
    if (!layer?.objects) return;
    // Tiled stores object coords in PIXELS, not tile indices.
    for (const obj of layer.objects) {
      this.spawnPoints.set(obj.name, {
        x: Math.floor(obj.x / this.tileSize),
        y: Math.floor(obj.y / this.tileSize)
      });
    }
  }

  private markWalkableSpawnPoints(): void {
    for (const [name, point] of this.spawnPoints) {
      if (!TiledMapRenderer.WALKABLE_SPAWN_PREFIXES.some((p) => name.startsWith(p))) continue;
      if (point.y >= 0 && point.y < this.height && point.x >= 0 && point.x < this.width) {
        this.walkabilityGrid[point.y][point.x] = true;
      }
    }
  }

  private parseZones(): void {
    const layer = this.findLayer(ZONES_LAYER, 'objectgroup');
    if (!layer?.objects) return;
    for (const obj of layer.objects) {
      this.zones.set(obj.name, {
        x: Math.floor(obj.x / this.tileSize),
        y: Math.floor(obj.y / this.tileSize),
        width: Math.floor((obj.width ?? 0) / this.tileSize),
        height: Math.floor((obj.height ?? 0) / this.tileSize)
      });
    }
  }

  /** Resolve a gid to its tileset. Scans BACKWARDS, so `tilesets` must be in
   *  ascending firstgid order (Tiled always writes them that way). */
  private resolveTileset(
    tileId: number
  ): { tileset: TiledTilesetRef; texture: Texture } | undefined {
    for (let i = this.mapData.tilesets.length - 1; i >= 0; i--) {
      if (tileId >= this.mapData.tilesets[i].firstgid) {
        return { tileset: this.mapData.tilesets[i], texture: this.tilesetTextures[i] };
      }
    }
    return undefined;
  }

  /** One tile's sub-rectangle of its tileset image, as a Texture. */
  private sliceTile(tileset: TiledTilesetRef, sheet: Texture, localId: number): Texture {
    const cols = tileset.columns ?? 16;
    const tw = tileset.tilewidth ?? this.tileSize;
    const th = tileset.tileheight ?? this.tileSize;
    const frame = new Rectangle((localId % cols) * tw, Math.floor(localId / cols) * th, tw, th);
    return new Texture({ source: sheet.source, frame });
  }

  private parseTileAnimations(): void {
    this.mapData.tilesets.forEach((tileset, i) => {
      const sheet = this.tilesetTextures[i];
      if (!sheet) return;
      for (const tile of tileset.tiles ?? []) {
        if (!tile.animation?.length) continue;
        this.animatedTiles.set(tileset.firstgid + tile.id, {
          textures: tile.animation.map((f) => this.sliceTile(tileset, sheet, f.tileid)),
          // A zero duration would spin the advance loop forever.
          durations: tile.animation.map((f) => Math.max(16, f.duration)),
          sprites: [],
          elapsedMs: 0,
          frame: 0
        });
      }
    });
  }

  private buildTileLayers(): number {
    if (this.mapData.tilesets.length === 0) return 0;
    let painted = 0;

    for (const layerName of TILE_LAYERS) {
      const layer = this.findLayer(layerName, 'tilelayer');
      const container = new Container();
      container.label = layerName;

      if (layer?.data) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const raw = layer.data[y * this.width + x];
            if (raw === 0) continue;

            const flippedH = (raw & FLIPPED_H_FLAG) !== 0;
            const flippedV = (raw & FLIPPED_V_FLAG) !== 0;
            const flippedD = (raw & FLIPPED_D_FLAG) !== 0;
            const tileId = raw & TILE_ID_MASK;

            const resolved = this.resolveTileset(tileId);
            if (!resolved) continue;

            const { tileset, texture } = resolved;
            if (!texture) continue;

            const animation = this.animatedTiles.get(tileId);
            const sprite = new Sprite(
              animation
                ? animation.textures[animation.frame]
                : this.sliceTile(tileset, texture, tileId - tileset.firstgid)
            );
            animation?.sprites.push(sprite);

            if (flippedH || flippedV || flippedD) {
              sprite.anchor.set(0.5, 0.5);
              sprite.x = x * this.tileSize + this.tileSize / 2;
              sprite.y = y * this.tileSize + this.tileSize / 2;
              if (flippedD) {
                if (flippedH && !flippedV) {
                  sprite.rotation = Math.PI / 2;
                } else if (!flippedH && flippedV) {
                  sprite.rotation = -Math.PI / 2;
                } else if (flippedH && flippedV) {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.y = -1;
                } else {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.x = -1;
                }
              } else {
                if (flippedH) sprite.scale.x = -1;
                if (flippedV) sprite.scale.y = -1;
              }
            } else {
              sprite.x = x * this.tileSize;
              sprite.y = y * this.tileSize;
            }

            container.addChild(sprite);
            painted++;
          }
        }
      }

      // `furniture-above` draws over characters, so the character layer is
      // inserted just before it.
      if (layerName === 'furniture-above') this.rootContainer.addChild(this.characterContainer);
      this.rootContainer.addChild(container);
    }

    return painted;
  }

  private findLayer(name: string, type: 'tilelayer' | 'objectgroup'): TiledLayer | undefined {
    return this.mapData.layers.find((l) => l.name === name && l.type === type);
  }
}
