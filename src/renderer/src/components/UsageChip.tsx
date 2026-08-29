import { useEffect, useState } from 'react';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useUsageStore } from '@/store/usageStore';
import { useStore } from '@/store/store';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import type { UsageProviderSnapshot, UsageWindow } from '@shared/usageTypes';
import { GaugeIcon } from '@/components/icons';
import { gaugeTone, type GaugeTone } from '@/design/gaugeTone';
import { formatResetIn, formatAgo } from '@/design/usageFormat';
import { primaryUsageProvider } from '@/design/usageWindows';

/** How often the popover's own "resets in Xh Ym" / "as of Xm ago" readouts
 *  re-render while open — this is a local re-render tick only, NOT a fetch
 *  (the actual data refresh is the throttled `refreshUsageNow` call on
 *  open — see usageService.ts's MANUAL_REFRESH_MIN_INTERVAL_MS). */
const COUNTDOWN_TICK_MS = 30_000;

/** The chip's three mini-gauges (session-status composite design, item 1) —
 *  '5h' / '7d' / '7d fable' off whichever provider `primaryUsageProvider`
 *  picks, in that fixed order; a label the provider doesn't have (most
 *  commonly '7d fable' — only Claude's `limits[]` ever produces it) is just
 *  omitted rather than shown empty. Never a credits/spend row — same
 *  "not a rate limit" exclusion `tightestWindow` below already applies. */
function miniGauges(providers: UsageProviderSnapshot[]): UsageWindow[] {
  const provider = primaryUsageProvider(providers);
  if (!provider) return [];
  const pick = (label: string): UsageWindow | undefined =>
    provider.windows.find((w) => w.label === label && !w.balanceOnly && !w.spend);
  const gauges = [pick('5h'), pick('7d'), pick('7d fable')].filter((w): w is UsageWindow => !!w);
  return gauges;
}

/** Per-window identity color for the mini-gauge LABEL only (user feedback:
 *  "hard to distinguish the three bars" — a fixed color by window label, not
 *  urgency; `gaugeTone` below still owns the %/fill color unchanged). */
function usageWindowClass(label: string): 'w5h' | 'wfable' | 'w7d' {
  if (label === '5h') return 'w5h';
  if (label === '7d fable') return 'wfable';
  return 'w7d';
}

/** The single tightest (highest used%) window across every provider that
 *  currently has real data ('ok' fresh, or 'stale' last-known-good under a
 *  429 gate) — null when no provider has a number to show yet (still
 *  loading, or every provider is in an error/expired/unauthorized state).
 *  The CHIP stays visible even when this is null (see UsageChip's own gate,
 *  which is on `providers.length`, not on this) — a Claude-only user whose
 *  token was rotated must still see the chip so they can reach the popover's
 *  actionable "re-authenticate" row; only the numeric label is conditional
 *  on this. A credits/balance row (`spend` or `balanceOnly` set) is never a
 *  candidate — it's a spend balance, not a rate limit, and letting it win
 *  here would repurpose the chip's "how close to a real limit" meaning into
 *  "how much of my monthly credit is gone", which isn't what it means today. */
function tightestWindow(providers: UsageProviderSnapshot[]): UsageWindow | null {
  let tightest: UsageWindow | null = null;
  for (const p of providers) {
    if (p.state !== 'ok' && p.state !== 'stale') continue;
    for (const w of p.windows) {
      if (w.spend || w.balanceOnly) continue;
      if (!tightest || w.usedPercent > tightest.usedPercent) tightest = w;
    }
  }
  return tightest;
}

/** Chip tone when there's no numeric tightest window to color it by (every
 *  provider errored/expired/unauthorized) — worst-state-wins, so a rotated
 *  token still reads as urgent even with nothing to plot. */
function fallbackTone(providers: UsageProviderSnapshot[]): GaugeTone {
  if (providers.some((p) => p.state === 'unauthorized')) return 'danger';
  if (providers.some((p) => p.state === 'expired')) return 'warn';
  return 'normal';
}

/** One rate-limit gauge row — pixel HP-style bar (hard edges, 0-2px radius,
 *  charcoal ground / gold fill, matching the roster card's own gauge). A
 *  `balanceOnly` row (Codex's credit balance — no known max, see
 *  usageTypes.ts) skips the percent/bar entirely and just shows the label
 *  plus its pre-formatted `balanceText`, per the "gauge if it has a max,
 *  plain text if it's a balance" requirement. */
function UsageWindowRow({ window: w, now }: { window: UsageWindow; now: number }): JSX.Element {
  if (w.balanceOnly) {
    return (
      <div className="usage-window">
        <div className="usage-window-head">
          <span className="usage-window-label">{w.label}</span>
        </div>
        {w.balanceText && <div className="usage-window-foot">{w.balanceText}</div>}
      </div>
    );
  }
  const tone = gaugeTone(w.usedPercent);
  const resetText = formatResetIn(w.resetsAt, now);
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-window-label">{w.label}</span>
        <span className="usage-window-pct">{Math.round(w.usedPercent)}%</span>
      </div>
      <div className="usage-bar">
        <div className={`usage-bar-fill usage-bar-fill--${tone}`} style={{ width: `${Math.round(w.usedPercent)}%` }} />
      </div>
      {(resetText || w.spend) && (
        <div className="usage-window-foot">
          {resetText && <span>{resetText}</span>}
          {w.spend && (
            <span>
              ${(w.spend.usedCents / 100).toFixed(2)} / ${(w.spend.limitCents / 100).toFixed(2)} {w.spend.currency}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One provider's section of the popover — header always renders (feedback:
 *  "keep the provider section header visible so the user can tell WHICH
 *  provider is unhappy"), body depends on state. */
function UsageProviderSection({ snapshot, now }: { snapshot: UsageProviderSnapshot; now: number }): JSX.Element {
  const label = AGENT_PROVIDERS[snapshot.provider]?.label ?? snapshot.provider;
  return (
    <div className="usage-provider">
      <div className="usage-provider-head">{label}</div>

      {snapshot.state === 'ok' &&
        snapshot.windows.map((w, i) => <UsageWindowRow key={`${w.label}-${i}`} window={w} now={now} />)}

      {snapshot.state === 'stale' && (
        <>
          <p className="usage-row-message usage-row-message--stale">
            {snapshot.message} · {formatAgo(snapshot.updatedAt, now)}
          </p>
          {snapshot.windows.map((w, i) => (
            <UsageWindowRow key={`${w.label}-${i}`} window={w} now={now} />
          ))}
        </>
      )}

      {snapshot.state === 'unauthorized' && <p className="usage-row-message usage-row-message--danger">{snapshot.message}</p>}
      {snapshot.state === 'expired' && <p className="usage-row-message usage-row-message--warn">{snapshot.message}</p>}
      {snapshot.state === 'error' && <p className="usage-row-message usage-row-message--muted">{snapshot.message}</p>}
    </div>
  );
}

/** Cost strip below the provider sections — reuses the SAME per-session
 *  `cost` telemetry AgentRosterCard.tsx already renders (costWatcher.ts),
 *  just summed across every currently-tracked session; deliberately NOT a
 *  "cost today / 30d" figure (no daily/rolling aggregation exists anywhere
 *  in this app, and building one is new cost parsing, out of this task's
 *  scope) — see this component's own header comment. Omitted entirely when
 *  no session has cost data yet. Sessions keep their `cost` field after
 *  they finish (see shared/types.ts), so this deliberately says "tracked",
 *  not "live" — it's every session still in the store, not just running
 *  ones. */
function UsageCostStrip(): JSX.Element | null {
  const sessions = useStore((s) => s.sessions);
  const withCost = sessions.filter((s) => s.cost);
  if (withCost.length === 0) return null;
  const totalCostUsd = withCost.reduce((sum, s) => sum + (s.cost?.costUsd ?? 0), 0);
  return (
    <div className="usage-cost-strip">
      tracked cost · {withCost.length} session{withCost.length === 1 ? '' : 's'} · ${totalCostUsd.toFixed(2)}
    </div>
  );
}

/**
 * Topbar usage-limits chip + "trainer card" popover (BACKLOG "next up" item
 * 1) — same anchored-popover shape as AudioPopover.tsx/QuickSettings.tsx
 * (outside-click catcher, Escape closes). Renders NOTHING (not even the
 * trigger button) unless the settings toggle is on AND EITHER a provider has
 * a real number to show (`tightestWindow`) OR a provider needs the user's
 * action (`expired`/`unauthorized` — CodexBar-parity feedback: the chip must
 * stay reachable so that red re-authenticate row can be seen). A provider
 * that's merely `error` ("usage unavailable", nothing actionable) or
 * `stale`-with-no-prior-data does NOT keep the chip alive on its own — task
 * spec: "chip renders ONLY when... at least one provider has data"; a
 * permanent contentless chip for a plain fetch failure would violate that.
 */
export function UsageChip(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const usageLimitsEnabled = useAppSettingsStore((s) => s.settings.usageLimitsEnabled);
  const snapshot = useUsageStore((s) => s.snapshot);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Popover-open refresh (task spec) — throttled MAIN-side to once/min, so
  // it's safe to fire on every open without this component tracking its own
  // cooldown. Also ticks `now` locally so "resets in"/"as of" stay roughly
  // live while the popover is open.
  useEffect(() => {
    if (!open) return;
    void window.api.refreshUsageNow().then((s) => useUsageStore.getState().hydrate(s));
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  if (!usageLimitsEnabled) return null;

  const tightest = tightestWindow(snapshot.providers);
  const needsUser = snapshot.providers.some((p) => p.state === 'expired' || p.state === 'unauthorized');
  if (!tightest && !needsUser) return null;

  const tone = tightest ? gaugeTone(tightest.usedPercent) : fallbackTone(snapshot.providers);
  const tip = tightest ? 'provider usage limits' : 'provider usage — needs attention';
  // Session-status composite design, item 1 — up to three chip-form mini
  // gauges (5h / 7d / 7d fable) instead of the old single text readout;
  // degrades to whichever provider `miniGauges` picks (Claude, else Codex),
  // and to icon-only when neither has a numeric window (mirrors the old
  // `{tightest && ...}` gate exactly).
  const gauges = miniGauges(snapshot.providers);

  return (
    <div className="usage-popover">
      <button
        type="button"
        className={`tip usage-chip usage-chip--${tone}`}
        data-tip={tip}
        aria-label={tip}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {/* Redundant next to three real bars — kept only for the icon-only
         * fallback state (no numeric windows) so the chip still reads as
         * clickable for the re-authenticate flow. */}
        {gauges.length === 0 && <GaugeIcon />}
        {gauges.length > 0 && (
          <span className="usage-chip-gauges">
            {gauges.map((w) => {
              const gaugeToneValue = gaugeTone(w.usedPercent);
              return (
                <span
                  key={w.label}
                  className={`usage-chip-gauge usage-chip-gauge--${gaugeToneValue} usage-chip-gauge--${usageWindowClass(w.label)}`}
                >
                  <span className="hp-bar">
                    <span
                      className={`hp-bar-fill${gaugeToneValue !== 'normal' ? ` ${gaugeToneValue}` : ''}`}
                      style={{ width: `${Math.round(w.usedPercent)}%` }}
                    />
                  </span>
                  <span className="usage-chip-gauge-label">{w.label}</span> <b>{Math.round(w.usedPercent)}%</b>
                </span>
              );
            })}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="usage-popover-catcher" onClick={() => setOpen(false)} />
          <div className="usage-popover-panel" role="dialog" aria-label="provider usage limits">
            {snapshot.providers.map((p) => (
              <UsageProviderSection key={p.provider} snapshot={p} now={now} />
            ))}
            <UsageCostStrip />
          </div>
        </>
      )}
    </div>
  );
}
