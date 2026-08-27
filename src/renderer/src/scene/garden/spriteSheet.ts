/**
 * Frame-rectangle math shared by every sprite sheet source: the bundled
 * Showdown PNGs (one row, `columns === frameCount`) and runtime-decoded GIFs
 * for unbundled species, which wrap into multiple rows once a sheet would
 * exceed 8192px wide (see `lazySprites.ts`). One helper, so both sources slice
 * frames the same way.
 */
import { Rectangle, Texture } from 'pixi.js';

export interface FrameGeometry {
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  /** Frames per row. Defaults to `frameCount` (a single row) when omitted. */
  columns?: number;
}

/** The sub-rectangle of frame `i` within a sheet laid out row-major. */
export function frameRect(geo: FrameGeometry, i: number): Rectangle {
  const columns = geo.columns ?? geo.frameCount;
  const col = i % columns;
  const row = Math.floor(i / columns);
  return new Rectangle(col * geo.frameWidth, row * geo.frameHeight, geo.frameWidth, geo.frameHeight);
}

/** Slice one sheet texture into its frame textures, sharing the sheet's GPU
 *  source rather than copying pixels. */
export function sliceFrames(sheet: Texture, geo: FrameGeometry): Texture[] {
  return Array.from(
    { length: geo.frameCount },
    (_, i) => new Texture({ source: sheet.source, frame: frameRect(geo, i) })
  );
}
