import { Container } from 'pixi.js';

// Ported from munder-difflin (src/renderer/src/scene/office/Camera.ts), itself a
// simplified port of shahar061/the-office (office/engine/camera.ts).
// Kept: fit-to-screen, map-edge clamping, smooth lerp, manual focus.
// Dropped: the decaying nudgeToward (we follow the selected walker outright).

const LERP_SPEED = 0.08;

export class Camera {
  private container: Container;
  private currentX = 0;
  private currentY = 0;
  private currentZoom = 1;
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;
  private viewWidth = 960;
  private viewHeight = 800;
  private mapWidth = 640;
  private mapHeight = 480;
  private manualOverride = false;
  /** The `container` transform actually applied by the last `update()` call
   *  — compared against the freshly-computed one on the NEXT call so it can
   *  report whether anything actually moved (dirty-flag rendering,
   *  renderDirty.ts). Deliberately the rendered OUTPUT (post-lerp,
   *  post-clamp), not `current*`/`target*`: `pan()`/`zoomAt()` write
   *  `current*` directly (bypassing the lerp) so a drag/wheel gesture tracks
   *  the pointer exactly, which means comparing against a stale `current*`
   *  snapshot would miss the very first `update()` call after one of those
   *  (the lerp step itself would see `target === current` already and add
   *  zero) — comparing the actual container transform catches every path
   *  that can move it (lerp settling toward a target, a direct pan/zoom
   *  write, or a resize-driven clamp) uniformly, with no per-path bookkeeping. */
  private lastAppliedX = NaN;
  private lastAppliedY = NaN;
  private lastAppliedZoom = NaN;
  /** True once the user has panned/zoomed away from whatever focusOn/
   *  fitToScreen last set — GardenScene's ticker stops calling either while
   *  this is set, so a drag/wheel gesture isn't immediately overridden on
   *  the very next frame. Cleared on every selection change (including
   *  deselect), never by time or motion alone — see GardenScene.tsx. */
  private freeLook = false;

  constructor(container: Container) {
    this.container = container;
  }

  setMapSize(width: number, height: number): void {
    this.mapWidth = width;
    this.mapHeight = height;
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    if (!this.manualOverride && !this.freeLook) this.fitToScreen();
  }

  isFreeLook(): boolean {
    return this.freeLook;
  }

  /** Cancels free-look so the ticker's automatic focusOn/fitToScreen resumes
   *  next frame — called on every selection change (garden click deselect,
   *  Escape, picking a session), never on a timer. */
  setFreeLook(v: boolean): void {
    this.freeLook = v;
  }

  getZoom(): number {
    return this.currentZoom;
  }

  private getMinZoom(): number {
    if (this.viewWidth === 0 || this.viewHeight === 0) return 1;
    return Math.min(this.viewWidth / this.mapWidth, this.viewHeight / this.mapHeight);
  }

  /** Fit the whole map to the viewport, centered. */
  fitToScreen(): void {
    this.manualOverride = false;
    this.targetX = this.mapWidth / 2;
    this.targetY = this.mapHeight / 2;
    this.targetZoom = this.getMinZoom();
  }

  /** Pan/zoom toward a world point (used when a session is selected). */
  focusOn(worldX: number, worldY: number, zoom?: number): void {
    this.manualOverride = true;
    this.targetX = worldX;
    this.targetY = worldY;
    this.targetZoom = Math.max(this.getMinZoom(), Math.min(4, zoom ?? this.currentZoom));
  }

  /** Clamp a candidate center point the same way `update()` clamps the
   *  rendered container position (below) — shared by `pan`/`zoomAt` so
   *  neither can drift the camera's target past the map edges. */
  private clampCenter(x: number, y: number, zoom: number): { x: number; y: number } {
    const halfW = this.viewWidth / (2 * zoom);
    const halfH = this.viewHeight / (2 * zoom);
    const cx = this.mapWidth <= halfW * 2 ? this.mapWidth / 2 : Math.min(this.mapWidth - halfW, Math.max(halfW, x));
    const cy = this.mapHeight <= halfH * 2 ? this.mapHeight / 2 : Math.min(this.mapHeight - halfH, Math.max(halfH, y));
    return { x: cx, y: cy };
  }

  /** Pan by a world-space delta (drag on empty ground). Written straight to
   *  `current*` as well as `target*` — unlike focusOn/fitToScreen, a grab
   *  gesture needs to track the pointer exactly; lerping it would make the
   *  ground visibly lag the cursor. Breaks the camera into free-look. */
  pan(dxWorld: number, dyWorld: number): void {
    this.freeLook = true;
    const c = this.clampCenter(this.targetX + dxWorld, this.targetY + dyWorld, this.targetZoom);
    this.targetX = c.x;
    this.targetY = c.y;
    this.currentX = c.x;
    this.currentY = c.y;
  }

  /** Zoom toward/away from a screen-space point (wheel/pinch), keeping that
   *  point visually fixed under the cursor. Like `pan`, written straight to
   *  `current*` too — anchoring from a still-lerping position would make the
   *  cursor's point drift instead of staying pinned on a continuous wheel
   *  gesture. Breaks the camera into free-look. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    this.freeLook = true;
    // Based on `targetZoom` (the settled intent), not `currentZoom` (which
    // can still be lerping toward it — e.g. mid-approach into a just-picked
    // session's 2.4x focus) — basing this on a still-in-flight value would
    // make the very first wheel notch after a selection/deselect snap the
    // zoom back to wherever the lerp happened to be instead of stepping from
    // where the camera is actually headed. The cursor-anchor math below
    // still reads `current*`, correctly: that's what's ACTUALLY on screen
    // right now, which is what must stay pinned under the cursor.
    const newZoom = Math.max(this.getMinZoom(), Math.min(4, this.targetZoom * factor));
    const worldX = this.currentX + (screenX - this.viewWidth / 2) / this.currentZoom;
    const worldY = this.currentY + (screenY - this.viewHeight / 2) / this.currentZoom;
    const c = this.clampCenter(
      worldX - (screenX - this.viewWidth / 2) / newZoom,
      worldY - (screenY - this.viewHeight / 2) / newZoom,
      newZoom
    );
    this.targetX = c.x;
    this.targetY = c.y;
    this.targetZoom = newZoom;
    this.currentX = c.x;
    this.currentY = c.y;
    this.currentZoom = newZoom;
  }

  /** Returns whether `container`'s transform actually changed this call —
   *  see `lastAppliedX`'s own comment. GardenScene's ticker calls this
   *  unconditionally every frame (free-look or not, settled or not) and
   *  uses the return value as a dirty-flag rendering source. */
  update(): boolean {
    this.currentX += (this.targetX - this.currentX) * LERP_SPEED;
    this.currentY += (this.targetY - this.currentY) * LERP_SPEED;
    this.currentZoom += (this.targetZoom - this.currentZoom) * LERP_SPEED;

    this.container.scale.set(this.currentZoom);
    this.container.x = this.viewWidth / 2 - this.currentX * this.currentZoom;
    this.container.y = this.viewHeight / 2 - this.currentY * this.currentZoom;

    const scaledW = this.mapWidth * this.currentZoom;
    const scaledH = this.mapHeight * this.currentZoom;
    if (scaledW <= this.viewWidth) {
      this.container.x = (this.viewWidth - scaledW) / 2;
    } else {
      this.container.x = Math.min(0, Math.max(this.viewWidth - scaledW, this.container.x));
    }
    if (scaledH <= this.viewHeight) {
      this.container.y = (this.viewHeight - scaledH) / 2;
    } else {
      this.container.y = Math.min(0, Math.max(this.viewHeight - scaledH, this.container.y));
    }

    const changed =
      this.container.x !== this.lastAppliedX ||
      this.container.y !== this.lastAppliedY ||
      this.currentZoom !== this.lastAppliedZoom;
    this.lastAppliedX = this.container.x;
    this.lastAppliedY = this.container.y;
    this.lastAppliedZoom = this.currentZoom;
    return changed;
  }
}
