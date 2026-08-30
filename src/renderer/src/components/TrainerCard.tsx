import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import type { Session } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useUsageStore } from '@/store/usageStore';
import type { UsageWindow } from '@shared/usageTypes';
import { PokemonFace } from '@/components/PokemonFace';
import { speciesEntry } from '@/scene/garden/dexData';
import { ModelBadge } from '@/components/ModelBadge';
import { TrainerCardIcon } from '@/components/icons';
import { formatContextCompact } from '@/components/CostGauge';
import { gaugeTone } from '@/design/gaugeTone';
import { selectedUsageProvider, usageWindow, usageCreditsWindow } from '@/design/usageWindows';
import { formatResetIn, formatAgo } from '@/design/usageFormat';

/** Same local re-render tick UsageChip.tsx's own popover uses for its
 *  "resets in"/"as of" readouts — not a fetch, just keeps them roughly live
 *  while this popover is open. */
const COUNTDOWN_TICK_MS = 30_000;

/** Fixed-position anchor for the panel, captured off the trigger badge's
 *  `getBoundingClientRect()` at open time — see `.trainer-card-panel`'s own
 *  CSS comment for why this popover uses `position: fixed` (measured
 *  coordinates) instead of the `position: absolute` anchor UsageChip.tsx/
 *  AudioPopover.tsx use: every mount site here (roster strip, focus
 *  sidebar, sessions overview) sits inside an `overflow: hidden`/`auto`
 *  scroll container that would otherwise clip the panel. */
interface Anchor {
  left: number;
  /** Exactly one of these is set — `bottom` pins the panel above the
   *  trigger (the common case: more room above than below), `top` pins it
   *  below when there isn't enough room above (e.g. the focus sidebar's
   *  first card or two, right under the topbar). */
  bottom?: number;
  top?: number;
}

/** Rough panel height (head + up to 6 stat rows + foot, `.trainer-card-
 *  panel`'s own content) — used only to pick open-up vs open-down at
 *  measure time, not for layout; doesn't need to be exact. */
const PANEL_MAX_HEIGHT = 300;

function hpBarStyle(usedPercent: number): { className: string; width: string } {
  const tone = gaugeTone(usedPercent);
  return {
    className: `hp-bar-fill${tone !== 'normal' ? ` ${tone}` : ''}`,
    width: `${Math.round(usedPercent)}%`
  };
}

/** One rate-limit gauge row inside the card body — omitted entirely when the
 *  primary provider doesn't have this window (e.g. '7d fable' on an account
 *  without that promotional model). */
function TrainerGaugeRow({ label, window: w }: { label: string; window: UsageWindow | undefined }): JSX.Element | null {
  if (!w) return null;
  const bar = hpBarStyle(w.usedPercent);
  return (
    <div className="trainer-stat">
      <div className="trainer-stat-head">
        <span>{label}</span>
        <span>{Math.round(w.usedPercent)}%</span>
      </div>
      <div className="hp-bar">
        <div className={bar.className} style={{ width: bar.width }} />
      </div>
    </div>
  );
}

/**
 * The popover's actual content — a SEPARATE component from TrainerCard
 * below, mounted only while the trigger is open (see TrainerCard's own
 * `{open && anchor && <TrainerCardPanel .../>}`). Its own `useUsageStore`/
 * battlers subscriptions and derived-window lookups therefore only run
 * while a user actually has this card's popover open, not on every cost
 * tick for every roster card in the strip (perf constraint: "memoize where
 * the roster re-renders per cost tick").
 */
function TrainerCardPanel({
  session,
  anchor,
  onClose
}: {
  session: Session;
  anchor: Anchor;
  onClose: () => void;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const snapshot = useUsageStore((s) => s.snapshot);
  const mainUsageProvider = useAppSettingsStore((s) => s.settings.mainUsageProvider);
  const runningCount = useStore((s) => s.battlers.filter((b) => b.parentId === session.id).length);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const cost = session.cost;
  // Same `mainUsageProvider` resolution UsageChip.tsx's mini-gauges use, so
  // this card's provider, its windows, and its "as of Xm ago" freshness
  // readout (`freshText` below) always agree on which provider they're
  // reading — settings → usage → "main usage provider".
  const provider = selectedUsageProvider(snapshot.providers, mainUsageProvider);
  const fiveHour = usageWindow(snapshot.providers, '5h', mainUsageProvider);
  const sevenDay = usageWindow(snapshot.providers, '7d', mainUsageProvider);
  const sevenDayFable = usageWindow(snapshot.providers, '7d fable', mainUsageProvider);
  const credits = usageCreditsWindow(snapshot.providers, mainUsageProvider);
  const resetWindow = sevenDay ?? fiveHour;
  const resetText = resetWindow ? formatResetIn(resetWindow.resetsAt, now) : null;
  const freshText = provider ? formatAgo(provider.updatedAt, now) : null;

  const speciesLabel = (speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase();
  const contextPct = cost ? Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100) : null;
  const contextBar = contextPct != null ? hpBarStyle(contextPct) : null;

  return (
    <>
      <div
        className="trainer-card-catcher"
        onClick={(e) => {
          // The catcher is `position: fixed` but still a DOM descendant of
          // `.roster-card-wrap` — without this, a click here bubbles up the
          // card's ancestor chain, which in the sessions-overview surface
          // includes `.modal-backdrop` (its own click-outside-closes
          // handler would then also dismiss the whole overview dialog).
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        className="trainer-card-panel"
        role="dialog"
        aria-label={`${session.title} trainer card`}
        style={{ left: anchor.left, bottom: anchor.bottom, top: anchor.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="trainer-card-head">
          <span className="trainer-card-sprite">
            <PokemonFace name={session.pokemon} box={40} shiny={session.shiny} />
          </span>
          <div className="trainer-card-id">
            <div className="trainer-card-title">{session.title}</div>
            <div className="trainer-card-sub">{speciesLabel}</div>
            {cost?.model && (
              <div className="trainer-card-model">
                <ModelBadge model={cost.model} changedFrom={session.modelChangedFrom} />
              </div>
            )}
          </div>
        </div>
        <div className="trainer-card-body">
          {cost && contextBar && (
            <div className="trainer-stat">
              <div className="trainer-stat-head">
                <span>context</span>
                <span>
                  {formatContextCompact(cost.contextTokens)} / {formatContextCompact(cost.contextWindow)}
                </span>
              </div>
              <div className="hp-bar">
                <div className={contextBar.className} style={{ width: contextBar.width }} />
              </div>
            </div>
          )}
          <TrainerGaugeRow label="5h window" window={fiveHour} />
          <TrainerGaugeRow label="7d window" window={sevenDay} />
          <TrainerGaugeRow label="7d fable" window={sevenDayFable} />
          {credits && (
            <div className="trainer-stat">
              <div className="trainer-stat-head">
                <span>credits</span>
                <span>
                  {credits.spend
                    ? `$${(credits.spend.usedCents / 100).toFixed(2)} / $${(credits.spend.limitCents / 100).toFixed(2)} ${credits.spend.currency}`
                    : credits.balanceText}
                </span>
              </div>
            </div>
          )}
          <div className="trainer-stat">
            <div className="trainer-stat-head">
              <span>multitask</span>
              <span>{runningCount > 0 ? `⇶ ${runningCount} running` : '⇶ idle'}</span>
            </div>
          </div>
        </div>
        {(resetText || freshText) && (
          <div className="trainer-card-foot">
            <span>{resetText ?? ''}</span>
            <span>{freshText ?? ''}</span>
          </div>
        )}
      </div>
    </>
  );
}

interface Props {
  session: Session;
}

/**
 * Trainer-card popover trigger (session-status feature, design direction 5
 * item 5) — the one home for the account-level 5h / 7d / 7d-fable / credits
 * windows relocated off the statusline strip (SessionStatusStrip.tsx), plus
 * this session's own portrait, model, context, and multitask. A small
 * corner badge on the AgentRosterCard; clicking it opens `TrainerCardPanel`
 * above, anchored to the badge's measured position (see that component's
 * own header comment for why `position: fixed` + `getBoundingClientRect()`
 * instead of the CSS-only anchor UsageChip.tsx/AudioPopover.tsx use).
 * Outside-click/Escape-close is the same behavior those share.
 */
export function TrainerCard({ session }: Props): JSX.Element {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAnchor(null);
    };
    // Closes when a scroll happens INSIDE the trigger's own ancestor chain
    // (capture-phase, so it sees scrolling on whichever container actually
    // moved the trigger) — the fixed-position panel doesn't move with its
    // scroll container, so keeping it open while the trigger scrolls away
    // would leave it visually detached. Scoped to `contains(trigger)`
    // rather than every scroll on the page: an unscoped listener also fires
    // for xterm's own auto-scrolling viewport on every output chunk, which
    // would close the popover mid-open on any actively-streaming session —
    // that element never contains the trigger, so it's correctly ignored.
    const onScroll = (e: Event): void => {
      const target = e.target;
      if (target instanceof Node && triggerRef.current && target.contains(triggerRef.current)) setAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor]);

  return (
    <span className="trainer-card-popover">
      <button
        ref={triggerRef}
        type="button"
        className="roster-card-trainer-trigger tip"
        data-tip="trainer card"
        aria-label="open trainer card"
        aria-expanded={anchor != null}
        aria-haspopup="dialog"
        // Sits inside `.roster-card-wrap`, a sibling of the card's own
        // `<button class="roster-card">` select target (same reasoning as
        // that button's `.roster-card-swap` sibling) — stopPropagation keeps
        // a click here from also bubbling to anything that would select the
        // session.
        onClick={(e) => {
          e.stopPropagation();
          setAnchor((current) => {
            if (current) return null;
            const rect = triggerRef.current?.getBoundingClientRect();
            if (!rect) return null;
            // Open upward (pinned above the trigger) when there's enough
            // room; otherwise open downward, pinned below it — a fixed
            // panel escapes ancestor clipping but not the viewport itself,
            // and near the top of a scrollable list (e.g. the focus
            // sidebar's first card or two) opening up alone would run the
            // panel's head off-screen.
            const openUp = rect.top >= PANEL_MAX_HEIGHT;
            return openUp
              ? { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
              : { left: rect.left, top: rect.bottom + 4 };
          });
        }}
      >
        <TrainerCardIcon />
      </button>

      {anchor && <TrainerCardPanel session={session} anchor={anchor} onClose={() => setAnchor(null)} />}
    </span>
  );
}
