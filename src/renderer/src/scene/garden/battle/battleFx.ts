/**
 * Small, self-contained visual effects for subagent battles (Phase 4 Part B).
 * Everything here composes with a walker/battler purely from the OUTSIDE, via
 * its already-public `container` — no changes to Walker/WalkerSprite/
 * EvolutionCeremony internals.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { bumpCounter } from '@/diagnosticsCounters';
import { safeLogDiagnostic } from '@/diagnosticsClient';

/** A brief white flash over a hit target — added as a transient child of its
 *  container, sized to roughly cover the sprite, then removed. */
export function spawnHitFlash(container: Container, width: number, height: number): void {
  const g = new Graphics();
  g.roundRect(-width / 2, -height, width, height, 3).fill({ color: 0xffffff, alpha: 0.75 });
  g.zIndex = 99999;
  container.addChild(g);
  const DURATION = 0.16;
  let elapsed = 0;
  const tick = (dt: number): boolean => {
    elapsed += dt;
    g.alpha = Math.max(0, 1 - elapsed / DURATION);
    if (elapsed >= DURATION) {
      container.removeChild(g);
      g.destroy();
      return true;
    }
    return false;
  };
  registerFx(container, tick);
}

/** A handful of small stars bursting outward and fading — the victory pose's
 *  sparkle. Added to `container`, self-removing. */
export function spawnSparkleBurst(container: Container): void {
  const N = 8;
  const parts: { g: Graphics; angle: number; speed: number }[] = [];
  for (let i = 0; i < N; i++) {
    const g = new Graphics();
    const s = 1.5 + Math.random() * 1.5;
    g.rect(-s, -0.4, s * 2, 0.8).fill({ color: 0xfff6c8, alpha: 1 });
    g.rect(-0.4, -s, 0.8, s * 2).fill({ color: 0xfff6c8, alpha: 1 });
    g.zIndex = 99999;
    container.addChild(g);
    parts.push({ g, angle: (i / N) * Math.PI * 2 + Math.random() * 0.3, speed: 14 + Math.random() * 10 });
  }
  const DURATION = 0.6;
  let elapsed = 0;
  const tick = (dt: number): boolean => {
    elapsed += dt;
    const t = elapsed / DURATION;
    for (const p of parts) {
      p.g.x = Math.cos(p.angle) * p.speed * elapsed;
      p.g.y = -Math.sin(p.angle) * p.speed * elapsed - 10;
      p.g.alpha = Math.max(0, 1 - t);
    }
    if (t >= 1) {
      for (const p of parts) {
        container.removeChild(p.g);
        p.g.destroy();
      }
      return true;
    }
    return false;
  };
  registerFx(container, tick);
}

/** Floating text that drifts up and fades — the battle's "«Species» used
 *  «Tool»!" move text and the victory/spawn flavor lines. Mirrors Walker's
 *  own (private) evolution flavor text, duplicated here rather than shared
 *  because Battler has no equivalent floatLayer to hang a public method off. */
export function spawnMoveText(container: Container, text: string, aboveY: number): void {
  const t = new Text({
    text,
    style: {
      fontSize: 16,
      fontFamily: 'monospace',
      fontWeight: 'bold',
      fill: '#fff6c8',
      stroke: { color: 0x1b1b1b, width: 3 },
      align: 'center'
    }
  });
  t.scale.set(0.4);
  t.anchor.set(0.5, 1);
  t.y = aboveY;
  t.zIndex = 100000;
  container.addChild(t);
  const DURATION = 1.4;
  let elapsed = 0;
  const baseY = aboveY;
  const tick = (dt: number): boolean => {
    elapsed += dt;
    const p = elapsed / DURATION;
    t.y = baseY - elapsed * 12;
    t.alpha = p < 0.15 ? p / 0.15 : Math.min(1, (1 - p) / 0.25);
    if (p >= 1) {
      container.removeChild(t);
      t.destroy();
      return true;
    }
    return false;
  };
  registerFx(container, tick);
}

/** Discrete sizes a shiny sparkle's four-point star steps through — mirrors
 *  EvolutionCeremony's own star twinkle (a snappy stepped cycle reads as a
 *  GBA-style twinkle; a smoothly-eased scale doesn't). */
const SHINY_STAR_SIZES = [1.5, 2.5, 3.5];
/** White/pale-gold, alternated per star and per twinkle — "white/yellow
 *  four-point stars" per spec. */
const SHINY_STAR_COLORS = [0xffffff, 0xfff2a8];
const SHINY_STAR_TWINKLE_MS = 120;

function drawShinyStar(g: Graphics, size: number, color: number): void {
  g.clear();
  g.rect(-size, -0.5, size * 2, 1).fill({ color, alpha: 1 });
  g.rect(-0.5, -size, 1, size * 2).fill({ color, alpha: 1 });
}

/** The classic shiny reveal: a ring of 4-6 white/yellow four-point stars,
 *  twinkling as they drift outward from `aboveY`, over ~1s. Used both for a
 *  shiny session's walker on its first garden spawn and a shiny wild battler
 *  on spawn — see GardenScene/BattleManager. Modeled on this file's own
 *  `spawnSparkleBurst` (radiating parts, self-ticking, self-removing) and
 *  EvolutionCeremony's star twinkle (stepped size/color rather than a smooth
 *  scale), rather than a new particle system. */
export function spawnShinySparkle(container: Container, aboveY: number): void {
  const n = 4 + Math.floor(Math.random() * 3); // 4-6
  const MAX_RADIUS = 16;
  const parts: { g: Graphics; angle: number; sizeIdx: number; timer: number }[] = [];
  for (let i = 0; i < n; i++) {
    const g = new Graphics();
    g.zIndex = 99999;
    const sizeIdx = Math.floor(Math.random() * SHINY_STAR_SIZES.length);
    drawShinyStar(g, SHINY_STAR_SIZES[sizeIdx], SHINY_STAR_COLORS[i % 2]);
    container.addChild(g);
    parts.push({
      g,
      angle: (i / n) * Math.PI * 2 + Math.random() * 0.4,
      sizeIdx,
      timer: Math.random() * SHINY_STAR_TWINKLE_MS
    });
  }
  const DURATION = 1.0;
  let elapsed = 0;
  const tick = (dt: number): boolean => {
    elapsed += dt;
    const t = elapsed / DURATION;
    for (const p of parts) {
      const r = MAX_RADIUS * Math.min(1, t * 1.4);
      p.g.x = Math.cos(p.angle) * r;
      p.g.y = aboveY + Math.sin(p.angle) * r * 0.5;
      p.timer += dt * 1000;
      if (p.timer >= SHINY_STAR_TWINKLE_MS) {
        p.timer -= SHINY_STAR_TWINKLE_MS;
        p.sizeIdx = Math.floor(Math.random() * SHINY_STAR_SIZES.length);
        drawShinyStar(p.g, SHINY_STAR_SIZES[p.sizeIdx], SHINY_STAR_COLORS[Math.random() < 0.5 ? 0 : 1]);
      }
      p.g.alpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
    }
    if (t >= 1) {
      for (const p of parts) {
        container.removeChild(p.g);
        p.g.destroy();
      }
      return true;
    }
    return false;
  };
  registerFx(container, tick);
}

/** The classic "trainer spotted you" alert: a small white bubble with a bold
 *  "!" pops up above a head with a quick overshoot bounce, holds, then pops
 *  back out. Used at battle initiation — both the parent and the newly
 *  poofed-in challenger show one, and only once both finish does the
 *  approach walk begin (see BattleManager's 'alert' phase). Rendered like
 *  ToolBubble: built at native size, the whole thing scaled down for a crisp
 *  2x-native look rather than a blurry 1x one. */
export function spawnExclaimBubble(container: Container, aboveY: number, onDone?: () => void): void {
  const bubble = new Container();
  const bg = new Graphics();
  bg.roundRect(-8, -12, 16, 16, 3)
    .fill({ color: 0xffffff, alpha: 1 })
    .stroke({ width: 1.5, color: 0x1b1b1b });
  const mark = new Text({
    text: '!',
    style: { fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold', fill: '#e5484d', align: 'center' }
  });
  mark.anchor.set(0.5, 0.62);
  mark.x = 0;
  mark.y = -4;
  bubble.addChild(bg, mark);
  bubble.y = aboveY;
  bubble.zIndex = 100001;
  bubble.scale.set(0);
  container.addChild(bubble);

  const POP_IN = 0.15;
  const HOLD = 0.65;
  const POP_OUT = 0.15;
  const BASE_SCALE = 0.5; // crisp 2x-rendered look, matching ToolBubble's convention
  let elapsed = 0;
  const tick = (dt: number): boolean => {
    elapsed += dt;
    if (elapsed < POP_IN) {
      const t = elapsed / POP_IN;
      // Quick pop with a small overshoot bounce (0 -> 1.2x -> 1x), not a
      // smooth ease — that's what reads as a "spotted!" beat.
      const s = t < 0.7 ? (t / 0.7) * 1.15 : 1.15 - ((t - 0.7) / 0.3) * 0.15;
      bubble.scale.set(BASE_SCALE * s);
      bubble.alpha = Math.min(1, t / 0.6);
    } else if (elapsed < POP_IN + HOLD) {
      bubble.scale.set(BASE_SCALE);
      bubble.alpha = 1;
    } else if (elapsed < POP_IN + HOLD + POP_OUT) {
      const t = (elapsed - POP_IN - HOLD) / POP_OUT;
      bubble.scale.set(BASE_SCALE * (1 - t));
      bubble.alpha = 1 - t;
    } else {
      container.removeChild(bubble);
      bubble.destroy({ children: true });
      onDone?.();
      return true;
    }
    return false;
  };
  registerFx(container, tick);
}

/** Exported for Walker.ts's mega-evolution flash beat, which lives outside
 *  this file's own FX registry (registerFx/tickBattleFx) — same check, one
 *  definition. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A small pokéball, drawn on a 16x16 logical pixel grid. Keeping the grid
 *  explicit is intentional: Graphics' rects remain stepped and aliased at
 *  garden scale, instead of turning this effect into a smooth vector icon. */
function drawPokeballGraphic(g: Graphics, r: number): void {
  g.clear();
  const grid = [
    '......DDDD......',
    '....DDDDDDDD....',
    '...DDRRRRRRDD...',
    '..DDRRRRRRRRDD..',
    '..DRRRRRRRRRRD..',
    '.DRRRRRRRRRRRRD.',
    '.DRRRRRRRRRRRRD.',
    'DDDDDDDDDDDDDDDD',
    '.DWWWWWWWWWWWWD.',
    '.DWWWWWWWWWWWWD.',
    '.DWWWWWWWWWWWWD.',
    '.DWWWWWWWWWWWWD.',
    '..DWWWWWWWWWWD..',
    '..DDWWWWWWWWDD..',
    '....DDDDDDDD....',
    '......DDDD......'
  ];
  const colors: Record<string, number> = {
    D: 0x1b1b1b,
    R: 0xe5484d,
    W: 0xf2f2f2
  };
  const cell = (r * 2) / grid.length;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const color = colors[grid[y][x]];
      if (color === undefined) continue;
      g.rect(x * cell - r, y * cell - r, cell, cell).fill({ color });
    }
  }

  // The center button is a dark stepped ring with one bright pixel, and the
  // two slightly lighter red pixels sell the top-left glossy highlight.
  const buttonPixels = [
    [6, 6], [7, 6], [8, 6], [9, 6],
    [5, 7], [6, 7], [7, 7], [8, 7], [9, 7], [10, 7],
    [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8],
    [6, 9], [7, 9], [8, 9], [9, 9]
  ];
  for (const [x, y] of buttonPixels) {
    g.rect(x * cell - r, y * cell - r, cell, cell).fill({ color: 0x1b1b1b });
  }
  g.rect(7 * cell - r, 7 * cell - r, cell, cell).fill({ color: 0xf2f2f2 });
  g.rect(4 * cell - r, 3 * cell - r, cell, cell).fill({ color: 0xf06a63 });
  g.rect(3 * cell - r, 4 * cell - r, cell, cell).fill({ color: 0xf06a63 });
}

/** Draw a tiny plus-shaped glint using only square pixel blocks. */
function drawPixelGlint(g: Graphics, block: number, color: number): void {
  g.clear();
  g.rect(-block / 2, -block * 1.5, block, block * 3).fill({ color });
  g.rect(-block * 1.5, -block / 2, block * 3, block).fill({ color });
}

/** Pokéball recall — a stepped GBA-style return-to-ball sequence. The ball
 *  is a sibling of `spriteContainer`, so it does not get shrunk with the
 *  Pokémon. `onDone` fires once after the last sparkle, leaving the caller to
 *  perform the actual battler/walker teardown. */
export function spawnPokeballRecall(
  container: Container,
  spriteContainer: Container,
  spriteHeight: number,
  onDone: () => void
): void {
  const ball = new Graphics();
  const r = Math.max(5, spriteHeight * 0.16);
  drawPokeballGraphic(ball, r);
  const ballY = -spriteHeight * 0.72;
  ball.y = ballY;
  ball.zIndex = 100000;
  ball.alpha = 1;
  container.addChild(ball);

  const originalScaleX = spriteContainer.scale.x;
  const originalScaleY = spriteContainer.scale.y;
  const originalX = spriteContainer.x;
  const originalY = spriteContainer.y;
  const originalTint = spriteContainer.tint;
  const originalVisible = spriteContainer.visible;

  const impact = new Graphics();
  const pixel = Math.max(1, Math.round(r / 8));
  impact.rect(-pixel, -pixel, pixel * 2, pixel * 2).fill({ color: 0xffffff });
  impact.rect(-pixel * 3, -pixel / 2, pixel * 2, pixel).fill({ color: 0xffffff });
  impact.rect(pixel, -pixel / 2, pixel * 2, pixel).fill({ color: 0xffffff });
  impact.rect(-pixel / 2, -pixel * 3, pixel, pixel * 2).fill({ color: 0xffffff });
  impact.rect(-pixel / 2, pixel, pixel, pixel * 2).fill({ color: 0xffffff });
  impact.zIndex = 100001;
  impact.visible = false;
  container.addChild(impact);

  const sparkles = [new Graphics(), new Graphics(), new Graphics()];
  for (const sparkle of sparkles) {
    sparkle.zIndex = 100001;
    sparkle.visible = false;
    container.addChild(sparkle);
  }

  let restored = false;
  let cleaned = false;
  let finished = false;

  const restoreSprite = (): void => {
    if (restored) return;
    restored = true;
    if (spriteContainer.destroyed) return;
    spriteContainer.scale.set(originalScaleX, originalScaleY);
    spriteContainer.x = originalX;
    spriteContainer.y = originalY;
    spriteContainer.tint = originalTint;
    spriteContainer.visible = originalVisible;
  };

  const removeVisuals = (): void => {
    if (cleaned) return;
    cleaned = true;
    restoreSprite();
    for (const visual of [ball, impact, ...sparkles]) {
      if (visual.parent) visual.parent.removeChild(visual);
      if (!visual.destroyed) visual.destroy();
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    removeVisuals();
    onDone();
  };

  // Reduced motion still gives the renderer one composited frame, but the
  // visible frame is the actual pixel ball rather than the old white flash.
  if (prefersReducedMotion()) {
    ball.scale.set(1, 1);
    const tick = (): boolean => {
      finish();
      return true;
    };
    registerFx(container, tick, removeVisuals);
    return;
  }

  const FRAME_MS = 60;
  const RED_SILHOUETTE = 0xff5555;
  const PRESENT_SCALES = [0.7, 1.12, 1];
  const PRESENT_Y_OFFSETS = [-2, -1, 0];
  const SUCK_X_SCALES = [1, 0.88, 0.7, 0.52, 0.33];
  const SUCK_Y_SCALES = [1, 0.82, 0.62, 0.42, 0.08];
  const SNAP_SCALES = [
    { x: 1.14, y: 0.82 },
    { x: 0.88, y: 1.12 }
  ];
  const WOBBLE_X_OFFSETS = [0, -2, 2, 0];
  const VANISH_SPARKLES: Array<Array<{ x: number; y: number; size: number; color: number }>> = [
    [
      { x: -r * 1.2, y: -r * 0.8, size: 1, color: 0xffffff },
      { x: r * 1.1, y: -r * 0.2, size: 1, color: 0xfff6c8 }
    ],
    [
      { x: -r * 1.6, y: -r, size: 1.2, color: 0xffffff },
      { x: r * 1.6, y: -r * 0.55, size: 1.1, color: 0xfff6c8 },
      { x: 0, y: r * 1.35, size: 0.9, color: 0xffffff }
    ],
    [
      { x: -r * 1.95, y: -r * 1.2, size: 1.2, color: 0xfff6c8 },
      { x: r * 1.95, y: -r * 0.75, size: 1, color: 0xffffff }
    ]
  ];

  type RecallPhase = 'present' | 'silhouette' | 'suck' | 'snap' | 'wobble' | 'vanish';
  const phaseFrames: Record<RecallPhase, number> = {
    present: PRESENT_SCALES.length,
    silhouette: 1,
    suck: SUCK_X_SCALES.length,
    snap: SNAP_SCALES.length,
    wobble: WOBBLE_X_OFFSETS.length,
    vanish: VANISH_SPARKLES.length
  };
  const phases: RecallPhase[] = ['present', 'silhouette', 'suck', 'snap', 'wobble', 'vanish'];
  let phaseIndex = 0;
  let frameIndex = 0;
  let frameElapsed = 0;

  const setSpriteScaleAndPosition = (xScale: number, yScale: number): void => {
    const towardBall = 1 - yScale;
    spriteContainer.scale.set(originalScaleX * xScale, originalScaleY * yScale);
    spriteContainer.x = originalX * (1 - towardBall);
    spriteContainer.y = originalY + (ballY - originalY) * towardBall;
  };

  const setSparkleFrame = (frame: number): void => {
    const frameSparkles = VANISH_SPARKLES[frame];
    for (let i = 0; i < sparkles.length; i++) {
      const sparkle = sparkles[i];
      const spec = frameSparkles[i];
      if (!spec) {
        sparkle.visible = false;
        continue;
      }
      sparkle.visible = true;
      sparkle.x = ball.x + spec.x;
      sparkle.y = ball.y + spec.y;
      drawPixelGlint(sparkle, pixel * spec.size, spec.color);
    }
  };

  const applyFrame = (): void => {
    const phase = phases[phaseIndex];
    const frame = frameIndex;
    ball.visible = true;
    ball.alpha = 1;
    impact.visible = false;
    for (const sparkle of sparkles) sparkle.visible = false;

    if (phase === 'present') {
      spriteContainer.visible = originalVisible;
      spriteContainer.tint = originalTint;
      setSpriteScaleAndPosition(1, 1);
      ball.x = 0;
      ball.y = ballY + PRESENT_Y_OFFSETS[frame];
      ball.scale.set(PRESENT_SCALES[frame]);
    } else if (phase === 'silhouette') {
      spriteContainer.visible = originalVisible;
      spriteContainer.tint = RED_SILHOUETTE;
      setSpriteScaleAndPosition(1, 1);
      ball.x = 0;
      ball.y = ballY;
      ball.scale.set(1, 1);
    } else if (phase === 'suck') {
      spriteContainer.visible = originalVisible;
      spriteContainer.tint = RED_SILHOUETTE;
      setSpriteScaleAndPosition(SUCK_X_SCALES[frame], SUCK_Y_SCALES[frame]);
      ball.x = 0;
      ball.y = ballY;
      ball.scale.set(1, 1);
    } else if (phase === 'snap') {
      spriteContainer.visible = originalVisible;
      spriteContainer.tint = RED_SILHOUETTE;
      setSpriteScaleAndPosition(SUCK_X_SCALES[SUCK_X_SCALES.length - 1], SUCK_Y_SCALES[SUCK_Y_SCALES.length - 1]);
      ball.x = 0;
      ball.y = ballY;
      ball.scale.set(SNAP_SCALES[frame].x, SNAP_SCALES[frame].y);
      impact.x = ball.x;
      impact.y = ball.y;
      impact.visible = frame === 0;
    } else if (phase === 'wobble') {
      spriteContainer.visible = originalVisible;
      spriteContainer.tint = RED_SILHOUETTE;
      setSpriteScaleAndPosition(SUCK_X_SCALES[SUCK_X_SCALES.length - 1], SUCK_Y_SCALES[SUCK_Y_SCALES.length - 1]);
      ball.x = WOBBLE_X_OFFSETS[frame];
      ball.y = ballY;
      ball.scale.set(1, 1);
    } else {
      // The final frame hides the ball but leaves the pixel glints hanging in
      // space for one beat; the tiny silhouette is hidden with it.
      spriteContainer.tint = RED_SILHOUETTE;
      setSpriteScaleAndPosition(SUCK_X_SCALES[SUCK_X_SCALES.length - 1], SUCK_Y_SCALES[SUCK_Y_SCALES.length - 1]);
      setSparkleFrame(frame);
      ball.visible = frame < 2;
      spriteContainer.visible = frame < 2 && originalVisible;
    }
  };

  applyFrame();

  const tick = (dt: number): boolean => {
    if (finished) return true;
    frameElapsed += dt * 1000;
    while (frameElapsed >= FRAME_MS && !finished) {
      frameElapsed -= FRAME_MS;
      if (frameIndex + 1 < phaseFrames[phases[phaseIndex]]) {
        frameIndex += 1;
        applyFrame();
        continue;
      }
      if (phaseIndex + 1 >= phases.length) {
        finish();
        return true;
      }
      phaseIndex += 1;
      frameIndex = 0;
      applyFrame();
    }
    return finished;
  };
  registerFx(container, tick, removeVisuals);
}

// A tiny shared ticker for these fire-and-forget effects, so callers never
// need to remember to poll them each frame themselves. `tickBattleFx` is
// called once per frame from BattleManager.update().
type FxTick = (dt: number) => boolean; // returns true when finished

/** `owner` is the `container` an effect's own display objects were added to
 *  (e.g. a Battler's or Walker's own `.container`) — tracked per entry (not
 *  just per tick fn) specifically so a destroyed owner's leftover FX can be
 *  found and dropped, and so `tickBattleFx` can skip a tick whose owner (and
 *  therefore whose own display objects, added as its children) is already
 *  destroyed WITHOUT having to call it at all. See `purgeBattleFxFor` and the
 *  root-cause writeup below (2026-08-29 production crash — see
 *  BattleManager.ts's file header). */
interface FxEntry {
  owner: Container;
  tick: FxTick;
  /** Optional owner-purge cleanup for effects that temporarily mutate a
   *  display object outside their own transient children. */
  cleanup?: () => void;
}
let active: FxEntry[] = [];

/** Logged at most once (not per-frame/per-entry) — mirrors GardenScene.tsx's
 *  own `loggedBattleUpdateThrow` one-shot pattern — since the per-entry
 *  try/catch below already self-heals every time regardless of whether this
 *  has already logged. */
let fxErrorLogged = false;

function registerFx(owner: Container, tick: FxTick, cleanup?: () => void): void {
  active.push({ owner, tick, cleanup });
}

/**
 * ROOT CAUSE (2026-08-29 production crash — harness.log
 * 2026-08-28T23:37:20Z, `TypeError: Cannot set properties of null (setting
 * 'y')` inside a `tick` closure, thrown from this function's own `.filter`
 * callback): an FX's own display object (e.g. `spawnMoveText`'s `Text`) is a
 * CHILD of `owner` — when `owner.destroy({ children: true })` runs (Battler
 * .destroy(), reached from BattleManager's `reapSubs`/`destroyBattle`) while
 * that FX is still mid-animation (a challenger's own "used Task!" text runs
 * 1.4s; the poof-out + reap window that can call `destroy()` is under 1.1s
 * after the text spawns — see Battler.ts POOF_OUT_MS), Pixi's own
 * `Container.destroy()` sets `this._position = null` on every destroyed
 * child, so that FX's own next `tick` call (still setting `.y` on the now-
 * destroyed child) throws. Before this fix, that throw escaped `Array.filter`
 * inside `tickBattleFx`, which aborted the reassignment `active =
 * active.filter(...)` entirely — the poisoned entry was NEVER removed, so
 * next frame's `tickBattleFx` (and therefore `BattleManager.update`, which
 * calls it as the very first thing) threw again, EVERY frame, forever (the
 * one `harness.log` entry is log-dedup — see GardenScene.tsx's
 * `loggedBattleUpdateThrow` — not a one-shot failure; the underlying throw
 * recurred every tick, which is why `battlesStarted`/`subagentsCleanedUp`
 * froze for the rest of that session while `subagentsMaterialized` kept
 * climbing).
 *
 * Three-layer fix (belt and braces — cleanup paths may multiply):
 *   1. `Battler.destroy()` now calls `purgeBattleFxFor(this.container)`
 *      FIRST, so an FX tied to a battler that's being destroyed is dropped
 *      before it ever gets the chance to outlive its own display object.
 *   2. Defensive here regardless: an entry whose `owner` is already
 *      destroyed is dropped WITHOUT calling its tick at all (its own display
 *      objects were destroyed as `owner`'s children, so there's nothing left
 *      to animate).
 *   3. Still defensive beyond that: any tick that throws anyway (a future FX
 *      whose target isn't a direct child of the container it was registered
 *      against, say) is caught, dropped, and logged once — self-healing every
 *      time regardless of whether it's already logged, so this can never
 *      wedge again the way the unguarded `.filter` did.
 */
export function tickBattleFx(dt: number): void {
  if (active.length === 0) return;
  const next: FxEntry[] = [];
  for (const entry of active) {
    if (entry.owner.destroyed) continue; // layer 2 — see doc comment above
    let done: boolean;
    try {
      done = entry.tick(dt);
    } catch (err) {
      // layer 3 — see doc comment above
      bumpCounter('battleSignalErrors');
      if (!fxErrorLogged) {
        fxErrorLogged = true;
        safeLogDiagnostic('battle', 'error', 'battle FX tick threw — dropping this effect', {
          error: err instanceof Error ? (err.stack ?? err.message) : String(err)
        });
      }
      continue; // drop the offending entry; never re-add it
    }
    if (!done) next.push(entry);
  }
  active = next;
}

/** Drops every in-flight FX whose display objects were added under `owner` —
 *  called from `Battler.destroy()` (layer 1 of the fix above) before it
 *  destroys `owner` itself, so a still-animating FX (e.g. a challenger's own
 *  move text) never outlives the container it was ticking. */
export function purgeBattleFxFor(owner: Container): void {
  if (active.length === 0) return;
  const retained: FxEntry[] = [];
  for (const entry of active) {
    if (entry.owner === owner) entry.cleanup?.();
    else retained.push(entry);
  }
  active = retained;
}

/** Force-clear every in-flight effect — used when the garden itself tears
 *  down, so no stray ticker keeps running against destroyed containers. */
export function clearBattleFx(): void {
  for (const entry of active) entry.cleanup?.();
  active = [];
}
