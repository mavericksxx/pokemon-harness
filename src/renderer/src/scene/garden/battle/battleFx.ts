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
}
let active: FxEntry[] = [];

/** Logged at most once (not per-frame/per-entry) — mirrors GardenScene.tsx's
 *  own `loggedBattleUpdateThrow` one-shot pattern — since the per-entry
 *  try/catch below already self-heals every time regardless of whether this
 *  has already logged. */
let fxErrorLogged = false;

function registerFx(owner: Container, tick: FxTick): void {
  active.push({ owner, tick });
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
  active = active.filter((e) => e.owner !== owner);
}

/** Force-clear every in-flight effect — used when the garden itself tears
 *  down, so no stray ticker keeps running against destroyed containers. */
export function clearBattleFx(): void {
  active = [];
}
