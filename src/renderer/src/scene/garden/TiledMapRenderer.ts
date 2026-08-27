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

export interface TiledTilesetRef {
  firstgid: number;
  source?: string;
  image?: string;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
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
    this.tileSpriteCount = this.buildTileLayers();
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
            const cols = tileset.columns ?? 16;
            const tw = tileset.tilewidth ?? this.tileSize;
            const th = tileset.tileheight ?? this.tileSize;
            const localId = tileId - tileset.firstgid;
            const srcX = (localId % cols) * tw;
            const srcY = Math.floor(localId / cols) * th;

            const frame = new Rectangle(srcX, srcY, tw, th);
            const sprite = new Sprite(new Texture({ source: texture.source, frame }));

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
