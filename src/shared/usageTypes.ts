/** Types shared between main, preload and renderer for the in-app provider
 *  usage-limits panel (BACKLOG "next up" item 1) — Claude/Codex session and
 *  weekly rate-limit gauges, read from each CLI's own credential + usage
 *  endpoint (see docs/usage-limits-research.md) only while the settings
 *  toggle is on (`AppSettings.usageLimitsEnabled`, appSettingsTypes.ts).
 *  Computed entirely in main (src/main/usageService.ts) and pushed to the
 *  renderer over `usage:snapshot` — this file is just the wire shape.
 *  Cursor is intentionally absent (research doc §3: no viable individual
 *  usage endpoint without cookie-scraping, out of scope for v1). */

export type UsageProviderId = 'claude' | 'codex';

/** One rate-limit window/gauge — a session (5h) window, a weekly window, a
 *  model-scoped promotional window (e.g. "fable"), or a credits/extra-usage
 *  balance row (Claude's `extra_usage`, gauge; Codex's `credits.balance`,
 *  plain text — see `spend`/`balanceOnly` below). */
export interface UsageWindow {
  /** Short chip/bar label — '5h' | '7d' | '7d <model>' (e.g. '7d sonnet',
   *  '7d fable') | a bare scope name (lowercased) | 'credits'. */
  label: string;
  /** 0-100, already clamped — every upstream response already reports this
   *  as a percentage (see the research doc's "no scaling" note for Claude;
   *  Codex's `used_percent` is the same). Meaningless (0) when `balanceOnly`
   *  is true — there's no known max to compute a percentage against. */
  usedPercent: number;
  /** Epoch ms, or null when the upstream response didn't carry a reset time
   *  (Claude's `resets_at` is ISO-8601; Codex's is epoch seconds — both
   *  normalized to ms here so the renderer never has to know which). */
  resetsAt: number | null;
  /** Only present for the Claude `extra_usage` credits gauge (has a known
   *  monthly max, so it renders like the other gauges) — amounts are in
   *  CENTS per the research doc. */
  spend?: { usedCents: number; limitCents: number; currency: string };
  /** True for a credits/balance row with no known max (Codex's
   *  `credits.balance`) — the renderer shows `balanceText` instead of a
   *  gauge bar/percent. Never true alongside `spend`. */
  balanceOnly?: boolean;
  /** Human-readable balance text for a `balanceOnly` row. Unit is whatever
   *  the upstream response uses — UNVERIFIED for Codex (research doc only
   *  confirms a bare number, not a currency), so this is pre-formatted here
   *  rather than the renderer assuming a currency/scale. */
  balanceText?: string;
}

/** Distinguishes WHY a provider has no usable windows this poll, so the
 *  popover can show actionable, distinct copy instead of one generic
 *  "unavailable" (CodexBar parity, requested after the initial spec):
 *   - 'ok'           — `windows` is fresh data from this poll.
 *   - 'expired'      — credential's own `expiresAt` is already past; no
 *                       network call was made (research doc: never refresh).
 *   - 'unauthorized' — the endpoint itself rejected the (locally
 *                       not-expired) token with 401 — it was rotated/revoked
 *                       out from under us. Distinct from 'expired' so the
 *                       copy and (in the service) the retry-suppression
 *                       logic can differ.
 *   - 'stale'        — a Claude 429 gate is active; `windows` holds the last
 *                       KNOWN GOOD data (if any was ever fetched) rather
 *                       than nothing, alongside `updatedAt` for an "as of"
 *                       readout.
 *   - 'error'        — network/schema/other failure; `windows` is empty. */
export type UsageProviderState = 'ok' | 'expired' | 'unauthorized' | 'stale' | 'error';

export interface UsageProviderSnapshot {
  provider: UsageProviderId;
  state: UsageProviderState;
  /** Empty for 'expired' | 'unauthorized' | 'error'; last-known-good data
   *  for 'stale'; fresh data for 'ok'. */
  windows: UsageWindow[];
  /** Lowercase, actionable row copy for every non-'ok' state (see
   *  UsageProviderState's own doc above for exactly which copy). Undefined
   *  for 'ok'. */
  message?: string;
  /** Epoch ms this provider's `windows` were actually fetched — present for
   *  'ok' and 'stale' (the popover's "as of Xm ago" for a stale row). */
  updatedAt?: number;
}

export interface UsageSnapshot {
  /** Mirrors `AppSettings.usageLimitsEnabled` at the moment this snapshot was
   *  produced — false only ever pairs with an empty `providers` (the service
   *  tears down and stops touching credentials the instant the toggle flips
   *  off; see usageService.ts's `setEnabled`). */
  enabled: boolean;
  /** One entry per provider that has ANYTHING to report — Codex is omitted
   *  entirely (not even an 'error' entry) when `~/.codex` doesn't exist, per
   *  the research doc. */
  providers: UsageProviderSnapshot[];
  /** Epoch ms of the last poll attempt (successful or not), for the
   *  renderer's own "how fresh is this" reasoning. 0 before the first poll. */
  updatedAt: number;
}
