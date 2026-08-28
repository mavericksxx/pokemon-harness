/** Types shared between main, preload and renderer for the cost & context HUD
 *  (Phase 8.5 Wave B item 1). Dependency-free, matching audioTypes.ts's
 *  pattern. Computed entirely in main (src/main/costWatcher.ts, which parses
 *  the claude CLI's own transcript .jsonl files) and pushed to the renderer
 *  over `cost:update:<agentId>` — this file is just the wire shape. */

export interface SessionCostUpdate {
  /** Cumulative across the whole transcript (main chain only — see
   *  costWatcher.ts's isSidechain filter), not just the latest turn. */
  inputTokens: number;
  outputTokens: number;
  /** Approximate, model-priced — see costWatcher.ts's PRICE_TABLE. */
  costUsd: number;
  /** The MOST RECENT assistant turn's total input (input + cache_creation +
   *  cache_read) — an estimate of current context-window occupancy, not a
   *  cumulative figure. */
  contextTokens: number;
  /** The context window size costWatcher.ts assumed for `model` — see that
   *  file's CONTEXT_WINDOW_TABLE for the fallback used when the model isn't
   *  recognized. */
  contextWindow: number;
  model: string | null;
}
