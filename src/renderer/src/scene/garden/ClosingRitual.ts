import type { TiledMapRenderer } from './TiledMapRenderer';
import type { Walker } from './Walker';
import { ENTRANCE_SPAWN } from './stations';

/**
 * Closing-time sunset ritual (Phase 8.5 Wave B item 2) — every live
 * session's walker heads for the garden entrance and waves, then hands back
 * a wrapped-up count. Instantiated inside GardenScene's effect (same
 * lifecycle as BattleManager/GardenCharm) and driven from the scene's own
 * ticker.
 *
 * Deliberately reuses the walker's EXISTING interruption gates rather than
 * adding new ones: `Walker.goTo` already returns false while an evolution
 * ceremony (or, per this same item, a nap) is in progress, and a walker
 * mid-battle is not in `runtimes` the ritual is handed a snapshot of at all
 * in the caller's sense — GardenScene passes it every live walker, and a
 * battling one's `goTo` calls are absorbed by BattleManager owning its
 * position, so the retry loop below just keeps trying until the walker is
 * free. The 15s cap (CAP_MS) is the backstop for a walker that never frees
 * up in time — the spec's own "wait for it, cap total ritual at ~15s then
 * quit anyway."
 */

const CAP_MS = 15_000;
/** How often a still-gated walker retries its goTo call. */
const RETRY_INTERVAL_S = 0.5;

export interface RitualWalkerEntry {
  walker: Walker;
}

interface RitualState {
  entry: RitualWalkerEntry;
  phase: 'pending' | 'walking' | 'waved';
  retryTimer: number;
}

export class ClosingRitual {
  private active = false;
  private elapsedS = 0;
  private states = new Map<string, RitualState>();
  private entranceTile: { x: number; y: number };
  private onComplete: ((wrappedCount: number) => void) | null = null;

  constructor(map: TiledMapRenderer) {
    this.entranceTile = map.getSpawnPoint(ENTRANCE_SPAWN) ?? { x: 2, y: 2 };
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Begin the ritual for exactly the sessions in `entries` (a snapshot —
   *  taken once, at start; a session that spawns mid-ritual is not added
   *  retroactively, matching "closing time" being a point-in-time action). */
  start(entries: Map<string, RitualWalkerEntry>, onComplete: (wrappedCount: number) => void): void {
    if (this.active) return;
    this.active = true;
    this.elapsedS = 0;
    this.onComplete = onComplete;
    this.states = new Map(
      [...entries].map(([id, entry]) => [id, { entry, phase: 'pending' as const, retryTimer: 0 }])
    );
    if (this.states.size === 0) this.finish();
  }

  /** Escape cancels — restores normal lighting/reconcile by simply stopping;
   *  GardenScene's own applyState() picks the walkers back up on its next
   *  reconcile (their `lastStation` is unaffected by this class, so nothing
   *  needs resetting there). */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.onComplete = null;
    this.states.clear();
  }

  update(dt: number): void {
    if (!this.active) return;
    this.elapsedS += dt;

    let allWaved = true;
    for (const state of this.states.values()) {
      if (state.phase !== 'waved') {
        const { walker } = state.entry;
        if (state.phase === 'pending') {
          state.retryTimer -= dt;
          if (state.retryTimer <= 0) {
            state.retryTimer = RETRY_INTERVAL_S;
            // goTo returns false while a ceremony/nap/etc. owns the walker —
            // just retry next tick, per this file's header.
            if (walker.goTo(this.entranceTile)) state.phase = 'walking';
          }
        } else if (state.phase === 'walking') {
          const t = walker.tile;
          if (t.x === this.entranceTile.x && t.y === this.entranceTile.y) {
            walker.showFloatingText('👋');
            walker.bounce();
            state.phase = 'waved';
          }
        }
      }
      // Checked AFTER processing above, not before — a walker that arrives
      // and waves on THIS tick must count toward completion this same tick,
      // not one tick late.
      if (state.phase !== 'waved') allWaved = false;
    }

    if (allWaved || this.elapsedS >= CAP_MS / 1000) this.finish();
  }

  private finish(): void {
    if (!this.active) return;
    this.active = false;
    let wrapped = 0;
    for (const state of this.states.values()) if (state.phase === 'waved') wrapped++;
    const cb = this.onComplete;
    this.onComplete = null;
    this.states.clear();
    cb?.(wrapped);
  }
}
