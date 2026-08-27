/**
 * Small, self-contained visual effects for subagent battles (Phase 4 Part B).
 * Everything here composes with a walker/battler purely from the OUTSIDE, via
 * its already-public `container` — no changes to Walker/WalkerSprite/
 * EvolutionCeremony internals.
 */
import { Container, Graphics, Text } from 'pixi.js';

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
  registerFx(tick);
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
  registerFx(tick);
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
  registerFx(tick);
}

// A tiny shared ticker for these fire-and-forget effects, so callers never
// need to remember to poll them each frame themselves. `tickBattleFx` is
// called once per frame from BattleManager.update().
type FxTick = (dt: number) => boolean; // returns true when finished
let active: FxTick[] = [];

function registerFx(tick: FxTick): void {
  active.push(tick);
}

export function tickBattleFx(dt: number): void {
  if (active.length === 0) return;
  active = active.filter((tick) => !tick(dt));
}

/** Force-clear every in-flight effect — used when the garden itself tears
 *  down, so no stray ticker keeps running against destroyed containers. */
export function clearBattleFx(): void {
  active = [];
}
