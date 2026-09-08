/**
 * Pure most-recently-used bookkeeping for a bounded, string-keyed cache —
 * split out from lazySprites.ts so its eviction-order logic is testable in
 * plain Node (lazySprites.ts itself pulls in Pixi/canvas/DOM APIs that don't
 * exist outside a renderer). Tracks touch order only; a caller with its own
 * notion of "still in use" (lazySprites.ts's pin refcounts) checks that
 * itself before actually evicting a key `overflow()` returns — see
 * lazySprites.ts's evictViewOverflow/evictAnimationOverflow.
 */
export class LruTracker<K> {
  private readonly order: K[] = [];

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.order.length;
  }

  /** Record `key` as just accessed/inserted — moves it to the MRU end. */
  touch(key: K): void {
    const i = this.order.indexOf(key);
    if (i !== -1) this.order.splice(i, 1);
    this.order.push(key);
  }

  /** Drop `key` from tracking entirely (evicted, or never worth tracking in
   *  the first place). A no-op if `key` isn't currently tracked. */
  forget(key: K): void {
    const i = this.order.indexOf(key);
    if (i !== -1) this.order.splice(i, 1);
  }

  /** The oldest keys beyond the budget, oldest-first. Pure — doesn't mutate;
   *  the caller decides per key whether to actually evict (calling `forget`
   *  itself) or to keep it (re-`touch`ing it, e.g. because it turned out to
   *  still be pinned). */
  overflow(): K[] {
    const excess = this.order.length - this.limit;
    return excess > 0 ? this.order.slice(0, excess) : [];
  }
}
