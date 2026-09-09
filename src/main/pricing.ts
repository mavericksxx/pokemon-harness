/**
 * Claude Code model pricing — extracted from costWatcher.ts (which owned
 * this table privately until the tray popover's cost-history aggregation
 * (costHistory.ts/costHistoryScan.ts) needed the exact same $/token rates
 * and cache multipliers to price PAST transcripts, not just live-tracked
 * sessions. Single source of truth now; costWatcher.ts imports from here
 * instead of keeping its own copy.
 *
 * Source: the `claude-api` skill's cached pricing table (2026-06-24) —
 * Anthropic first-party API rates. Approximate by design (see the HUD
 * tooltip copy in AgentRosterCard.tsx) and does not attempt to track live
 * pricing changes.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** $/1M-token input/output rates. Keyed by PREFIX match (checked longest-
 *  first) since a real transcript's `message.model` can carry a dated
 *  snapshot suffix the table below doesn't enumerate — see
 *  `priceForModel`'s fallback. */
export const PRICE_TABLE: readonly [prefix: string, price: ModelPrice][] = [
  ['claude-fable-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-mythos-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-opus-5', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-opus-4', { inputPerMTok: 5, outputPerMTok: 25 }], // 4-8/4-7/4-6
  ['claude-sonnet-5', { inputPerMTok: 2, outputPerMTok: 10 }],
  ['claude-sonnet-4', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-haiku-4-5', { inputPerMTok: 1, outputPerMTok: 5 }]
];
/** Sonnet-tier rate — used when `model` is unset or unrecognized (a future
 *  model id, or a legacy one this table doesn't carry). */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

/** Cache-token cost multipliers relative to the model's INPUT rate — per the
 *  claude-api skill's own documented approximations ("~1.25x cost" for a
 *  cache write, "~0.1x cost" for a cache read), not a guess. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Claude Code uses angle-bracketed internal model ids for placeholder
 *  entries (e.g. `<synthetic>`); those must never replace a session's last
 *  real model. */
export function isPlaceholderModel(model: string | null): boolean {
  return model !== null && /^<[^>]+>$/.test(model);
}

export function priceForModel(model: string | null): ModelPrice {
  if (!model) return FALLBACK_PRICE;
  for (const [prefix, price] of PRICE_TABLE) {
    if (model.startsWith(prefix)) return price;
  }
  return FALLBACK_PRICE;
}

/** Prices one assistant turn's raw usage counters into a USD cost, per
 *  `model` — the exact formula costWatcher.ts applies to live sessions,
 *  factored out so costHistoryScan.ts prices PAST transcripts identically
 *  rather than re-deriving the formula. */
export function costForUsage(
  usage: { inputTok: number; cacheCreate: number; cacheRead: number; outputTok: number },
  model: string | null
): number {
  const price = priceForModel(model);
  return (
    (usage.inputTok * price.inputPerMTok +
      usage.cacheCreate * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      usage.cacheRead * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      usage.outputTok * price.outputPerMTok) /
    1_000_000
  );
}
