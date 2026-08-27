/**
 * PLACEHOLDER pixel art, generated at runtime onto a canvas.
 *
 * Written fresh for this project (not ported). It exists only so the garden has
 * something to render before real art lands, and it is deliberately ugly.
 *
 * SWAP SEAM: both functions return Pixi `Texture`s. To use real art, replace
 * `buildTilesetTexture()` with `Assets.load('<tileset>.png')` and
 * `buildWalkerSheet()` with a load + slice of a real 4x4 Pokemon-Essentials
 * character sheet. Nothing else in the scene changes — TiledMapRenderer takes
 * `Texture[]` and WalkerSprite takes `Texture[][]`.
 */
import { Rectangle, Texture } from 'pixi.js';
import tilesetSpec from './maps/placeholderTileset.json';

/** Tile ids MUST line up with placeholderTileset.json (and therefore the .tmj
 *  gids). Both read the same file, so the layout can never drift. */
const TILE_PAINTERS: Record<string, (c: CanvasRenderingContext2D) => void> = {
  grass: (c) => {
    fill(c, 0, 0, 16, 16, '#4e8f3c');
    dots(c, '#5da046', [[3, 4], [9, 2], [12, 9], [6, 12], [1, 10]]);
  },
  'grass-alt': (c) => {
    fill(c, 0, 0, 16, 16, '#478436');
    dots(c, '#6cae52', [[2, 3], [7, 7], [13, 4], [10, 13], [4, 11]]);
    fill(c, 6, 5, 1, 3, '#7dbd5e');
    fill(c, 12, 10, 1, 3, '#7dbd5e');
  },
  path: (c) => {
    fill(c, 0, 0, 16, 16, '#c2a878');
    dots(c, '#b09864', [[2, 5], [8, 3], [11, 11], [5, 13], [14, 7]]);
    dots(c, '#d4bc8e', [[6, 8], [12, 2], [3, 12]]);
  },
  'path-edge': (c) => {
    fill(c, 0, 0, 16, 16, '#7a9e52');
    dots(c, '#a89a68', [[4, 4], [11, 6], [7, 12], [13, 12]]);
  },
  water: (c) => {
    fill(c, 0, 0, 16, 16, '#4a9ec4');
    fill(c, 0, 6, 16, 1, '#6bb8da');
    fill(c, 0, 12, 16, 1, '#6bb8da');
  },
  'water-deep': (c) => {
    fill(c, 0, 0, 16, 16, '#2f77a3');
    fill(c, 3, 4, 6, 1, '#54a3cc');
    fill(c, 8, 10, 6, 1, '#54a3cc');
  },
  hedge: (c) => {
    fill(c, 0, 0, 16, 16, '#2c5a24');
    dots(c, '#3d7530', [[2, 2], [6, 4], [10, 2], [13, 5], [4, 9], [9, 11], [13, 13], [2, 13]]);
    fill(c, 0, 0, 16, 1, '#3f7c31');
  },
  tree: (c) => {
    fill(c, 6, 10, 4, 6, '#6b4a2a');
    ellipse(c, 8, 7, 7, 7, '#2f6b28');
    ellipse(c, 6, 5, 4, 4, '#3d8434');
    dots(c, '#54a343', [[9, 4], [5, 9], [11, 8]]);
  },
  flowers: (c) => {
    dots(c, '#e8556d', [[3, 4], [11, 3], [7, 9], [12, 11]]);
    dots(c, '#f6d34a', [[4, 5], [12, 4], [8, 10], [13, 12]]);
    dots(c, '#ffffff', [[2, 11], [9, 5]]);
    fill(c, 3, 6, 1, 3, '#3d7a2e');
    fill(c, 11, 5, 1, 3, '#3d7a2e');
    fill(c, 7, 11, 1, 3, '#3d7a2e');
  },
  signpost: (c) => {
    fill(c, 7, 6, 2, 10, '#7a5433');
    fill(c, 2, 2, 12, 6, '#a97b4a');
    fill(c, 3, 3, 10, 4, '#c9a26b');
    fill(c, 4, 4, 6, 1, '#6b4a2a');
    fill(c, 4, 6, 4, 1, '#6b4a2a');
  },
  stone: (c) => {
    ellipse(c, 8, 10, 5, 4, '#8d8f8a');
    ellipse(c, 7, 9, 3, 2, '#a6a8a2');
  },
  block: (c) => {
    c.globalAlpha = 0.5;
    fill(c, 0, 0, 16, 16, '#ff0044');
    c.globalAlpha = 1;
  }
};

function fill(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): void {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

function dots(c: CanvasRenderingContext2D, color: string, pts: number[][]): void {
  c.fillStyle = color;
  for (const [x, y] of pts) c.fillRect(x, y, 1, 1);
}

function ellipse(
  c: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string
): void {
  c.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    for (let x = -rx; x <= rx; x++) {
      if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) c.fillRect(cx + x, cy + y, 1, 1);
    }
  }
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function toPixelTexture(canvas: HTMLCanvasElement): Texture {
  const tex = Texture.from(canvas);
  // Pixel art: nearest lives on the SOURCE, not the texture.
  tex.source.scaleMode = 'nearest';
  return tex;
}

/** The placeholder tileset, laid out exactly as placeholderTileset.json declares. */
export function buildTilesetTexture(): Texture {
  const { columns, tilewidth, tileheight, imagewidth, imageheight, tiles } = tilesetSpec;
  const { canvas, ctx } = makeCanvas(imagewidth, imageheight);

  for (const tile of tiles) {
    const paint = TILE_PAINTERS[tile.key];
    if (!paint) continue;
    const x = (tile.id % columns) * tilewidth;
    const y = Math.floor(tile.id / columns) * tileheight;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, tilewidth, tileheight);
    ctx.clip();
    paint(ctx);
    ctx.restore();
  }

  return toPixelTexture(canvas);
}

// ─── Walker sheet ───────────────────────────────────────────────────────────
export const WALKER_FRAME = 32;
export const WALKER_COLS = 4;
export const WALKER_ROWS = 4; // down, left, right, up — Pokemon Essentials order

/** Vertical bob per animation column, so the walk cycle reads as steps. */
const STEP_BOB = [0, -1, 0, 1];

function paintWalker(
  c: CanvasRenderingContext2D,
  dir: number,
  frame: number,
  body: string,
  belly: string
): void {
  const cx = 16;
  const baseY = 27 + STEP_BOB[frame];
  const outline = '#20301c';

  // legs (alternate on frames 1 and 3)
  const swing = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  fill(c, cx - 6 + swing, baseY - 2, 4, 4, outline);
  fill(c, cx + 2 - swing, baseY - 2, 4, 4, outline);

  // body
  ellipse(c, cx, baseY - 8, 9, 8, outline);
  ellipse(c, cx, baseY - 8, 8, 7, body);
  ellipse(c, cx, baseY - 5, 5, 4, belly);

  // head
  ellipse(c, cx, baseY - 18, 8, 7, outline);
  ellipse(c, cx, baseY - 18, 7, 6, body);

  // ears
  fill(c, cx - 7, baseY - 25, 3, 4, body);
  fill(c, cx + 4, baseY - 25, 3, 4, body);
  fill(c, cx - 7, baseY - 25, 3, 1, outline);
  fill(c, cx + 4, baseY - 25, 3, 1, outline);

  // face, per direction: 0 down, 1 left, 2 right, 3 up
  const eyeY = baseY - 19;
  if (dir === 0) {
    fill(c, cx - 4, eyeY, 2, 2, outline);
    fill(c, cx + 2, eyeY, 2, 2, outline);
    fill(c, cx - 1, eyeY + 3, 2, 1, outline);
  } else if (dir === 1) {
    fill(c, cx - 5, eyeY, 2, 2, outline);
    fill(c, cx - 7, eyeY + 2, 2, 1, outline);
  } else if (dir === 2) {
    fill(c, cx + 3, eyeY, 2, 2, outline);
    fill(c, cx + 5, eyeY + 2, 2, 1, outline);
  }
  // dir === 3 (up): back of the head, no face.
}

/**
 * Build a 4x4 walker sheet (rows: down, left, right, up) tinted for one session,
 * sliced into `frames[row][col]` — the shape WalkerSprite expects.
 */
export function buildWalkerSheet(body: string, belly: string): Texture[][] {
  const { canvas, ctx } = makeCanvas(WALKER_FRAME * WALKER_COLS, WALKER_FRAME * WALKER_ROWS);

  for (let row = 0; row < WALKER_ROWS; row++) {
    for (let col = 0; col < WALKER_COLS; col++) {
      ctx.save();
      ctx.translate(col * WALKER_FRAME, row * WALKER_FRAME);
      ctx.beginPath();
      ctx.rect(0, 0, WALKER_FRAME, WALKER_FRAME);
      ctx.clip();
      paintWalker(ctx, row, col, body, belly);
      ctx.restore();
    }
  }

  const sheet = toPixelTexture(canvas);
  return Array.from({ length: WALKER_ROWS }, (_, row) =>
    Array.from({ length: WALKER_COLS }, (_, col) => {
      const frame = new Rectangle(
        col * WALKER_FRAME,
        row * WALKER_FRAME,
        WALKER_FRAME,
        WALKER_FRAME
      );
      return new Texture({ source: sheet.source, frame });
    })
  );
}
