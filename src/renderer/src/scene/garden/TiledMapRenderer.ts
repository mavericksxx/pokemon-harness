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
  /** Tiled's object `type` field. Zones use `'structure'` to mark an enclosed
   *  building's footprint for the roof-fade behaviour below. */
  type?: string;
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
/** Blocked tiles that are wet rather than solid. A flying Pokemon may cross
 *  these; a walking one may not. Not in TILE_LAYERS, so it is never drawn. */
const WATER_LAYER = 'water';
const SPAWN_POINTS_LAYER = 'spawn-points';
const ZONES_LAYER = 'zones';
/** Zone `type` that marks an enclosed structure's footprint (gen-garden-map.cjs
 *  writes this on the shed/greenhouse-style buildings, not on the merely
 *  informational region zones like `meadow` or `orchard`). */
const STRUCTURE_ZONE_TYPE = 'structure';
/** Alpha a structure's roof fades to while a walker's anchor tile is inside its
 *  zone, and the time constant (ms) of the tween toward that target. */
const STRUCTURE_FADE_ALPHA = 0.3;
const STRUCTURE_FADE_MS = 250;

export class TiledMapRenderer {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** Tile sprites actually painted — logged at startup as the cheap "did the map
   *  render?" signal. Zero here means the gid/tileset wiring is wrong. */
  readonly tileSpriteCount: number = 0;

  private walkabilityGrid: boolean[][] = [];
  private waterGrid: boolean[][] = [];
  private spawnPoints: Map<string, Point> = new Map();
  private zones: Map<string, ZoneRect> = new Map();
  private characterContainer: Container;
  private rootContainer: Container;
  /** gid → its animation, for gids the map's tilesets declare `animation` on. */
  private animatedTiles: Map<number, AnimatedTileGroup> = new Map();

  // ── enclosed-structure roof fade ──────────────────────────────────────────
  // An enclosed structure (potting shed, etc.) draws its `furniture-above`
  // tiles as a solid roof, in their own per-structure container stacked ABOVE
  // the walker layer (unlike tree canopy, which y-sorts WITH walkers) — so by
  // default it fully hides anyone inside. When a walker's anchor tile enters
  // the structure's zone, that container's alpha tweens down so they stay
  // visible; it tweens back up once the zone is empty again.
  /** Zones whose Tiled `type` is `structure`, keyed by zone/structure name. */
  private structureZones: Map<string, ZoneRect> = new Map();
  /** One container per structure, holding just its roof tiles. */
  private structureRoofs: Map<string, Container> = new Map();
  /** Current (tweening) alpha per structure. */
  private structureAlpha: Map<string, number> = new Map();
  /** Canopy sprites this renderer added to `characterContainer` itself (tree
   *  foliage) — excluded when scanning that container for walker occupants. */
  private canopySprites: Set<Sprite> = new Set();

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
    this.waterGrid = this.parseBoolLayer(WATER_LAYER);
    this.parseSpawnPoints();
    this.markWalkableSpawnPoints();
    this.parseZones();
    this.parseTileAnimations();
    this.tileSpriteCount = this.buildTileLayers();
  }

  /** Advance Tiled tile animations (the pond's water) and enclosed-structure
   *  roof fades. Call once per frame. */
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
    this.updateStructureFade(deltaMs);
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

  /** Water — blocked for walkers, passable for fliers. */
  isWater(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return this.waterGrid[ty][tx];
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

  /** A non-drawn tile layer read as a boolean mask (any non-zero gid = true). */
  private parseBoolLayer(name: string): boolean[][] {
    const layer = this.findLayer(name, 'tilelayer');
    const grid = Array.from({ length: this.height }, () => Array(this.width).fill(false));
    if (!layer?.data) return grid;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        grid[y][x] = (layer.data[y * this.width + x] & TILE_ID_MASK) !== 0;
      }
    }
    return grid;
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
      const rect: ZoneRect = {
        x: Math.floor(obj.x / this.tileSize),
        y: Math.floor(obj.y / this.tileSize),
        width: Math.floor((obj.width ?? 0) / this.tileSize),
        height: Math.floor((obj.height ?? 0) / this.tileSize)
      };
      this.zones.set(obj.name, rect);
      if (obj.type === STRUCTURE_ZONE_TYPE) {
        this.structureZones.set(obj.name, rect);
        this.structureAlpha.set(obj.name, 1);
      }
    }
  }

  /** The structure (if any) whose zone contains tile (x, y) — used to route a
   *  `furniture-above` tile into that structure's own fading roof container
   *  instead of the normal tree-canopy y-sort path. */
  private structureAt(x: number, y: number): string | undefined {
    for (const [name, rect] of this.structureZones) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
        return name;
      }
    }
    return undefined;
  }

  private getOrCreateStructureRoof(name: string): Container {
    let container = this.structureRoofs.get(name);
    if (!container) {
      container = new Container();
      container.label = `structure-roof:${name}`;
      this.structureRoofs.set(name, container);
    }
    return container;
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
      // `furniture-above` is canopy foliage (see gen-garden-map.cjs): every tile
      // on it sits exactly one row above its tree's trunk on `furniture-below`.
      // Rather than always drawing over characters, its sprites go straight into
      // the character container and get y-sorted against walkers by the trunk
      // row's depth, so a Pokemon standing in front of a tree's base occludes
      // the canopy instead of the canopy always winning.
      const isCanopy = layerName === 'furniture-above';
      const container = isCanopy ? this.characterContainer : new Container();
      if (!isCanopy) container.label = layerName;

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

            // A furniture-above tile inside a `structure` zone is that
            // building's roof, not tree canopy: it goes into its own
            // per-structure container (faded on occupancy, see
            // updateStructureFade) instead of the walker-sorted one below.
            const structureName = isCanopy ? this.structureAt(x, y) : undefined;

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

            if (structureName !== undefined) {
              // Roof tile: its own container, no y-sort, added on top of
              // everything (see below) — full occlusion until faded.
              this.getOrCreateStructureRoof(structureName).addChild(sprite);
            } else {
              if (isCanopy) {
                // Depth-key off the trunk row directly below this canopy tile
                // (y + 1), at its bottom pixel edge — the same "feet"
                // convention Walker uses for its own zIndex, so the two
                // compare correctly.
                sprite.zIndex = (y + 2) * this.tileSize;
                this.canopySprites.add(sprite);
              }
              container.addChild(sprite);
            }
            painted++;
          }
        }
      }

      if (!isCanopy) this.rootContainer.addChild(container);
    }

    // Now holding both walkers and canopy tiles, y-sorted together. Added last
    // so it still draws over the flat floor/walls/furniture-below layers.
    this.rootContainer.addChild(this.characterContainer);

    // Structure roofs draw on top of walkers too (that's the whole point —
    // they represent a real ceiling), so they need to come after the
    // character container. Fading them on occupancy is what keeps a walker
    // inside from disappearing for good.
    for (const roof of this.structureRoofs.values()) this.rootContainer.addChild(roof);

    return painted;
  }

  /** Tween each enclosed structure's roof toward transparent while a walker's
   *  anchor tile sits inside its zone, and back to opaque once it's empty.
   *  Walker positions are read straight off `characterContainer`'s children —
   *  every sprite this renderer put there itself is in `canopySprites` and
   *  skipped, so whatever's left is a walker's body or speech-bubble
   *  container (both track the walker's world position via `.x`/`.y`). */
  private updateStructureFade(deltaMs: number): void {
    if (this.structureZones.size === 0) return;

    const occupantTiles: Point[] = [];
    for (const child of this.characterContainer.children) {
      // Every tile sprite this renderer put here itself is in canopySprites;
      // skip it. Whatever's left is a walker's body or bubble container.
      if (this.canopySprites.has(child as Sprite)) continue;
      const px = child.x;
      const py = child.y;
      // An idle bubble container parked at the origin would otherwise read as
      // a permanent occupant of tile (0, 0).
      if (px === 0 && py === 0) continue;
      occupantTiles.push(this.pixelToTile(px, py - 1));
    }

    const rate = Math.min(1, deltaMs / STRUCTURE_FADE_MS);
    for (const [name, rect] of this.structureZones) {
      const occupied = occupantTiles.some(
        (t) => t.x >= rect.x && t.x < rect.x + rect.width && t.y >= rect.y && t.y < rect.y + rect.height
      );
      const target = occupied ? STRUCTURE_FADE_ALPHA : 1;
      const current = this.structureAlpha.get(name) ?? 1;
      const next = current + (target - current) * rate;
      this.structureAlpha.set(name, next);
      const roof = this.structureRoofs.get(name);
      if (roof) roof.alpha = next;
    }
  }

  private findLayer(name: string, type: 'tilelayer' | 'objectgroup'): TiledLayer | undefined {
    return this.mapData.layers.find((l) => l.name === name && l.type === type);
  }
}
