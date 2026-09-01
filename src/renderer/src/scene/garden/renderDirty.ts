/**
 * Dirty-flag (render-on-change) signal for the garden's Pixi canvas
 * (idle-energy pass follow-up, 2026-09-01 — the same triage that added
 * GardenScene.tsx's `syncRenderState` pause/resume). That earlier pass only
 * stopped rendering entirely while the garden is hidden/backgrounded; while
 * it's VISIBLE but nothing is actually moving (a fully idle garden — no
 * walker mid-bob/mid-step, no camera lerp in flight, no battle/ceremony/fx),
 * GardenScene.tsx still called Pixi's own auto `app.render()` listener 60
 * times a second for 60 identical frames. This module is the plumbing that
 * lets GardenScene take that render call over and skip the identical ones:
 * `app.ticker.remove(app.render, app)` is called once at mount (see
 * GardenScene.tsx), and its own game-logic ticker instead calls
 * `consumeDirty()` once, at the very end of every tick, to decide whether
 * this frame's `app.render()` actually needs to run.
 *
 * One shared, module-level flag rather than a class instance threaded
 * through every constructor: every file that can mutate anything on
 * `app.stage` — WalkerSprite (frame steps, bob), Walker (position, badge,
 * bubbles), Camera (pan/zoom/focus), BattleManager/Battler/battleFx,
 * TiledMapRenderer (tile animation, structure fade), GardenCharm — just
 * imports `markDirty` directly at its own point of mutation, the same
 * "cheap global signal, no plumbing" shape diagnosticsCounters.ts already
 * uses for `markRendererTick`. A handful of subsystems with a single, clear
 * "is this currently animating" flag (an in-flight battle, an evolution
 * ceremony, the closing ritual) mark dirty once per frame while that flag is
 * true instead of instrumenting every internal write — see each call site's
 * own comment for which shortcut it's taking and why it's safe.
 */

// Starts dirty so the very first frame after this module loads (i.e. the
// app's first ever mount) always paints, even before anything has had a
// chance to call markDirty() of its own accord.
let dirty = true;

/** Call at (or immediately after) any point that changes what the NEXT
 *  render would show. Cheap and idempotent — safe to call from a hot path
 *  (every sprite frame step, every walker every frame it's moving) with no
 *  batching/coalescing needed, since this is just a boolean OR. */
export function markDirty(): void {
  dirty = true;
}

/** Read-and-clear. Called exactly once per game-logic tick, at the very end
 *  of it, by GardenScene's own ticker — whatever marked dirty during this
 *  tick (or any tick since the last render) is what that render actually
 *  paints. A quiet tick right after leaves `dirty` false, so "render on
 *  change" is exactly that: one frame per change, not one forever after. */
export function consumeDirty(): boolean {
  const was = dirty;
  dirty = false;
  return was;
}
