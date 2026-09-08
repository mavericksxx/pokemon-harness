import type { Point } from './TiledMapRenderer';
import type { LiveBattler } from '@/store/store';
import { safeLogDiagnostic } from '@/diagnosticsClient';

/**
 * WebGL context-loss / rebuild machinery (garden-ui-crash triage,
 * 2026-08-29 — docs/triage/2026-08-29-garden-ui-crash.md), extracted
 * verbatim out of GardenScene.tsx's own effect body. Split into two halves
 * exactly like the original did, just now living in one module instead of
 * two scopes of the same closure:
 *
 *  - `GardenRebuildController`, instantiated ONCE per effect run (mirrors
 *    the original effect-scoped `let`s) and living across every
 *    `mountScene()` generation — `rebuild()`/the budget/`currentCleanup`/
 *    `pendingRespawn`/`pendingWalkerTiles` all need to survive a rebuild by
 *    definition, so they can't be re-created inside `mountScene` itself.
 *  - `attachContextLossListeners`, a method on that same controller but
 *    called fresh from INSIDE every `mountScene()` generation's `init()` —
 *    it closes over that generation's own `canvas`/`destroyed`, so it needs
 *    a per-generation call the same way the original inline listener setup
 *    did.
 *
 * `mountScene` itself is passed into `rebuild()`/`manualRebuild()` as a
 * parameter rather than stored on the controller — GardenScene.tsx defines
 * `mountScene` (a `const`) after constructing this controller, and passing
 * it in at call time (both call sites only ever fire well after that
 * `const` is assigned) sidesteps the forward-reference the original
 * same-scope closure relied on without needing a mutable holder for it.
 */
export class GardenRebuildController {
  private rebuildInFlight = false;
  private rebuildAttempts = 0;
  private lastRebuildAttemptAt = 0;
  // Cross-generation (survives a rebuild) so the "context lost" diagnostic
  // row below can report how long it's been since the PREVIOUS loss, not
  // just this generation's own downtime — that's what actually shows a
  // burst in the log, one row at a time, versus several unrelated losses
  // spread across a session.
  private lastContextLossAt = 0;
  // A burst of subagent battler spawns can knock the context out more than
  // twice within a single burst (each loss its own genuine event, not a
  // rebuild failing to stick) — 2 was tight enough that a busy burst alone
  // could exhaust the budget and land on the crash overlay. 4 gives a
  // burst (the triage log showed several losses inside one minute) real
  // room to breathe while still catching a genuine rebuild-fails-
  // immediately loop (see REBUILD_BUDGET_RESET_MS below for how the budget
  // stays bounded regardless).
  private readonly MAX_REBUILD_ATTEMPTS = 4;
  private readonly REBUILD_BUDGET_RESET_MS = 60_000;

  /** Assigned fresh by each `mountScene` generation, once `runtimes` exists
   *  for that generation (see walkerLifecycle.ts's `snapshotWalkerTiles`) —
   *  defaults to empty so a context loss landing before the very first
   *  generation has gotten that far still has something safe to call. */
  snapshotWalkerTiles: () => Map<string, Point> = () => new Map();
  // Snapshot of the store's `battlers` slice taken right before teardown —
  // the caller's own `cleanup()` (invoked from `rebuild()` below) tears
  // down the old BattleManager, and its `destroyBattle` calls
  // `onBattlerRemoved` for every live battler (GardenScene wires that to
  // `removeBattler`), so by the time the fresh `mountScene()` reconciles,
  // the store's own `battlers` array is already empty. This is what the
  // fresh generation's own respawn step actually reads instead.
  pendingRespawn: LiveBattler[] = [];
  pendingWalkerTiles: Map<string, Point> = new Map();
  /** The current generation's own teardown — assigned by `mountScene` the
   *  instant it starts (so an unmount or a rebuild landing mid-async-load
   *  still reaches it), and read both by `rebuild()` (below) and by the
   *  effect's own unmount return. */
  currentCleanup: (() => void) | null = null;

  constructor(private deps: { setCrashed: (crashed: boolean) => void; getBattlers: () => LiveBattler[] }) {}

  // What `rebuild()` will treat `rebuildAttempts` as once it actually
  // runs (it applies this same reset check itself, right before consulting
  // the cap) — shared so the "context lost" row's own `attempt` field
  // can't disagree with the "rebuilding renderer"/"attempts exhausted" row
  // that follows it a couple seconds later.
  budgetAdjustedAttempts(now: number): number {
    return this.lastRebuildAttemptAt && now - this.lastRebuildAttemptAt > this.REBUILD_BUDGET_RESET_MS
      ? 0
      : this.rebuildAttempts;
  }

  async rebuild(mountScene: () => Promise<void>): Promise<void> {
    if (this.rebuildInFlight) {
      safeLogDiagnostic('gpu', 'info', 'context-loss signal ignored — rebuild already in flight', {});
      return;
    }
    this.rebuildAttempts = this.budgetAdjustedAttempts(Date.now());
    if (this.rebuildAttempts >= this.MAX_REBUILD_ATTEMPTS) {
      safeLogDiagnostic('gpu', 'error', 'garden rebuild attempts exhausted — showing crash overlay', {
        attempts: this.rebuildAttempts
      });
      // Give up on this generation for real rather than leaving a dead
      // renderer (and its ticker) running invisibly behind the overlay.
      this.currentCleanup?.();
      this.currentCleanup = null;
      this.deps.setCrashed(true);
      return;
    }
    this.rebuildInFlight = true;
    this.rebuildAttempts += 1;
    this.lastRebuildAttemptAt = Date.now();
    safeLogDiagnostic('gpu', 'error', 'webgl context not restored — rebuilding renderer', {
      attempt: this.rebuildAttempts
    });
    try {
      this.pendingRespawn = this.deps.getBattlers().slice();
      this.pendingWalkerTiles = this.snapshotWalkerTiles();
      this.currentCleanup?.();
      this.currentCleanup = null;
      await mountScene();
      this.deps.setCrashed(false);
      safeLogDiagnostic('gpu', 'info', 'garden renderer rebuilt successfully', { attempt: this.rebuildAttempts });
    } catch (e) {
      safeLogDiagnostic('gpu', 'error', 'garden renderer rebuild failed', {
        attempt: this.rebuildAttempts,
        error: e instanceof Error ? (e.stack ?? e.message) : String(e)
      });
      this.deps.setCrashed(true);
    } finally {
      this.rebuildInFlight = false;
    }
  }

  // The crash overlay's own button — a deliberate user retry, so it gets a
  // fresh automatic budget rather than staying permanently stuck at the cap
  // from the earlier crash loop.
  manualRebuild(mountScene: () => Promise<void>): void {
    this.rebuildAttempts = 0;
    void this.rebuild(mountScene);
  }

  // WebGL/GPU context-loss instrumentation (garden-ui-crash triage,
  // 2026-08-29): a lost context used to leave the canvas silently dead with
  // ZERO trace in harness.log — no renderer JS exception (nothing throws;
  // lost-context GL calls are spec'd no-ops), no main-process signal,
  // nothing. Pixi's own GlContextSystem already listens for these same two
  // events on this canvas, calls `preventDefault()` on loss itself
  // (required for the browser to ever restore it) and rebuilds every
  // renderer system's GPU resources on restore, and the ticker never stops
  // ticking through any of this — so a context the BROWSER actually
  // restores needs nothing further here beyond logging.
  //
  // CONFIRMED PRODUCTION FAILURE (2026-08-29, harness.log 10:59:53Z-
  // 11:00:03Z): that assumption only covers the case the browser DOES
  // restore it — here it never did, and Pixi's self-heal never got a
  // chance to run, leaving a permanently dead canvas with nothing to
  // recover it. The 2s alarm below now calls `rebuild()` instead of only
  // logging.
  attachContextLossListeners(opts: {
    canvas: HTMLCanvasElement;
    isDestroyed: () => boolean;
    mountScene: () => Promise<void>;
  }): () => void {
    const CONTEXT_RESTORE_TIMEOUT_MS = 2_000;
    let contextLostAt = 0;
    let contextRestoreTimer: ReturnType<typeof setTimeout> | null = null;
    const onContextLost = (event: Event): void => {
      if (opts.isDestroyed()) return; // this generation is already being torn down
      event.preventDefault(); // required to allow the browser to restore it
      contextLostAt = Date.now();
      // Both surface a burst in the log even though each loss is its own
      // row: `attempt` is what `rebuild()` will treat the budget as once
      // its own 2s alarm actually fires — via the same
      // `budgetAdjustedAttempts` reset check `rebuild()` applies itself,
      // so this can't log a stale pre-reset count that the very next row
      // then contradicts. `secondsSinceLastLoss` is null the very first
      // loss this session has ever seen.
      const secondsSinceLastLoss = this.lastContextLossAt
        ? Math.round((contextLostAt - this.lastContextLossAt) / 1000)
        : null;
      this.lastContextLossAt = contextLostAt;
      safeLogDiagnostic('gpu', 'error', 'webgl context lost', {
        statusMessage: (event as WebGLContextEvent).statusMessage || undefined,
        attempt: this.budgetAdjustedAttempts(contextLostAt),
        secondsSinceLastLoss
      });
      if (contextRestoreTimer) clearTimeout(contextRestoreTimer);
      contextRestoreTimer = setTimeout(() => {
        contextRestoreTimer = null;
        safeLogDiagnostic('gpu', 'error', 'webgl context lost, not restored after 2s', {});
        void this.rebuild(opts.mountScene);
      }, CONTEXT_RESTORE_TIMEOUT_MS);
    };
    const onContextRestored = (): void => {
      if (opts.isDestroyed()) {
        // Stale event from a generation already torn down (e.g. a rebuild
        // already underway) — the listener normally can't outlive its own
        // removeEventListener call in `cleanup`, but this is the same
        // "subsequent signals no-op with a log row" guard `rebuild` itself
        // uses, kept here too for defense-in-depth.
        safeLogDiagnostic('gpu', 'info', 'context restored signal ignored — this generation already torn down', {});
        return;
      }
      if (contextRestoreTimer) {
        clearTimeout(contextRestoreTimer);
        contextRestoreTimer = null;
      }
      safeLogDiagnostic('gpu', 'info', 'webgl context restored', {
        downtimeMs: contextLostAt ? Date.now() - contextLostAt : null
      });
    };
    opts.canvas.addEventListener?.('webglcontextlost', onContextLost, false);
    opts.canvas.addEventListener?.('webglcontextrestored', onContextRestored, false);
    return (): void => {
      opts.canvas.removeEventListener?.('webglcontextlost', onContextLost);
      opts.canvas.removeEventListener?.('webglcontextrestored', onContextRestored);
      if (contextRestoreTimer) clearTimeout(contextRestoreTimer);
    };
  }
}
