import type { UsageProviderId, UsageProviderSnapshot, UsageWindow } from '@shared/usageTypes';

const usable = (p: UsageProviderSnapshot): boolean => p.state === 'ok' || p.state === 'stale';

/** Auto pick — Claude when it currently has usable data, Codex otherwise
 *  (session-status composite design's degradation rule: "if claude is
 *  excluded/off and only codex data exists, show codex's windows in the same
 *  form"). Null when neither provider has fresh or last-known-good ('stale')
 *  data right now. This is `AppSettings.mainUsageProvider`'s 'auto' value,
 *  and also the fallback `selectedUsageProvider` below lands on when the
 *  user's chosen provider has nothing to show yet. */
function autoUsageProvider(providers: UsageProviderSnapshot[]): UsageProviderSnapshot | null {
  return (
    providers.find((p) => p.provider === 'claude' && usable(p)) ??
    providers.find((p) => p.provider === 'codex' && usable(p)) ??
    null
  );
}

/** The provider the topbar chip's mini-gauges and the trainer-card popover
 *  both draw their 5h/7d/7d-fable numbers from, resolved against
 *  `AppSettings.mainUsageProvider` (settings → usage → "main usage
 *  provider"). `preferred` is a required param (not optional-defaulting-to-
 *  'auto') so every call site has to decide explicitly rather than silently
 *  inheriting the old auto-only behavior.
 *
 *  'auto' always falls through to `autoUsageProvider`. A specific chosen
 *  provider wins ONLY while it has usable ('ok' | 'stale') data; otherwise
 *  this also falls through to the auto pick — the chip/card must not go
 *  blank just because the chosen provider is still loading (or was toggled
 *  off via `usageExcludedProviders`, which simply omits it from `providers`
 *  entirely and so lands here the same way). */
export function selectedUsageProvider(
  providers: UsageProviderSnapshot[],
  preferred: UsageProviderId | 'auto'
): UsageProviderSnapshot | null {
  if (preferred !== 'auto') {
    const match = providers.find((p) => p.provider === preferred && usable(p));
    if (match) return match;
  }
  return autoUsageProvider(providers);
}

/** One rate-limit window off the resolved provider by its exact label ('5h' |
 *  '7d' | '7d fable') — never a credits/spend row (those aren't rate
 *  limits; see `usageCreditsWindow` below). */
export function usageWindow(
  providers: UsageProviderSnapshot[],
  label: string,
  preferred: UsageProviderId | 'auto'
): UsageWindow | undefined {
  const provider = selectedUsageProvider(providers, preferred);
  return provider?.windows.find((w) => w.label === label && !w.balanceOnly && !w.spend);
}

/** The resolved provider's credits/balance row, if its account exposes one —
 *  Claude's `extra_usage` (has `spend`) or Codex's balance (has
 *  `balanceOnly`/`balanceText`). Undefined when there's nothing to show. */
export function usageCreditsWindow(
  providers: UsageProviderSnapshot[],
  preferred: UsageProviderId | 'auto'
): UsageWindow | undefined {
  const provider = selectedUsageProvider(providers, preferred);
  return provider?.windows.find((w) => w.label === 'credits');
}
