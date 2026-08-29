import type { UsageProviderSnapshot, UsageWindow } from '@shared/usageTypes';

/** The provider the topbar chip's mini-gauges and the trainer-card popover
 *  both draw their 5h/7d/7d-fable numbers from — Claude when it currently
 *  has usable data, Codex otherwise (session-status composite design's
 *  degradation rule: "if claude is excluded/off and only codex data exists,
 *  show codex's windows in the same form"). Null when neither provider has
 *  fresh or last-known-good ('stale') data right now. */
export function primaryUsageProvider(providers: UsageProviderSnapshot[]): UsageProviderSnapshot | null {
  const usable = (p: UsageProviderSnapshot): boolean => p.state === 'ok' || p.state === 'stale';
  return (
    providers.find((p) => p.provider === 'claude' && usable(p)) ??
    providers.find((p) => p.provider === 'codex' && usable(p)) ??
    null
  );
}

/** One rate-limit window off the primary provider by its exact label ('5h' |
 *  '7d' | '7d fable') — never a credits/spend row (those aren't rate
 *  limits; see `usageCreditsWindow` below). */
export function usageWindow(providers: UsageProviderSnapshot[], label: string): UsageWindow | undefined {
  const provider = primaryUsageProvider(providers);
  return provider?.windows.find((w) => w.label === label && !w.balanceOnly && !w.spend);
}

/** The primary provider's credits/balance row, if its account exposes one —
 *  Claude's `extra_usage` (has `spend`) or Codex's balance (has
 *  `balanceOnly`/`balanceText`). Undefined when there's nothing to show. */
export function usageCreditsWindow(providers: UsageProviderSnapshot[]): UsageWindow | undefined {
  const provider = primaryUsageProvider(providers);
  return provider?.windows.find((w) => w.label === 'credits');
}
