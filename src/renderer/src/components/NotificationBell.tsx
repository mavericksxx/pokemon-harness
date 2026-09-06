import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { BellIcon } from '@/components/icons';

/** "2m ago"-style relative time for a notification row's `createdAt`. Not a
 *  live ticker — the popover is a short-lived, re-opened-fresh view, so a
 *  one-shot render-time computation is enough (same non-ticking treatment
 *  UsageChip.tsx's own "as of Xm ago" readout gets). */
function formatRelativeTime(createdAt: number, now: number): string {
  const diffSec = Math.max(0, Math.round((now - createdAt) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Topbar notification bell — an in-app-lifetime history of every
 * `pushToast`/`pushNotification` call (store.ts's `notifications`), newest
 * first, with a small unread-dot on the trigger. Follows AudioPopover.tsx's
 * exact structural pattern: a wrapper div (own ref, `no-drag` since the
 * topbar itself is an Electron drag region), an `open` state, Escape +
 * outside-pointerdown dismissal, and a right-anchored absolutely-positioned
 * panel.
 */
export function NotificationBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const notifications = useStore((s) => s.notifications);
  const markAllNotificationsRead = useStore((s) => s.markAllNotificationsRead);
  const clearAllNotifications = useStore((s) => s.clearAllNotifications);
  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const toggleOpen = (): void => {
    setOpen((v) => {
      const next = !v;
      if (next) markAllNotificationsRead();
      return next;
    });
  };

  const now = Date.now();
  const newestFirst = [...notifications].reverse();

  return (
    <div className="notification-bell" ref={wrapperRef}>
      <button
        type="button"
        className="topbar-icon-btn tip"
        data-tip="notifications"
        aria-label="notifications"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggleOpen}
      >
        <BellIcon />
        {unreadCount > 0 && <span className="notification-bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="notification-bell-panel" role="dialog" aria-label="notifications">
          {newestFirst.length === 0 ? (
            <div className="notification-bell-empty">no notifications yet</div>
          ) : (
            <>
              <div className="notification-bell-header">
                <button type="button" className="notification-bell-clear" onClick={clearAllNotifications}>
                  clear all
                </button>
              </div>
              <div className="notification-bell-list">
                {newestFirst.map((n) => (
                  <div key={n.id} className="notification-bell-row">
                    <div className="notification-bell-row-text">{n.text}</div>
                    <div className="notification-bell-row-meta">
                      <span className="notification-bell-row-time">{formatRelativeTime(n.createdAt, now)}</span>
                      {n.action && (
                        <button
                          type="button"
                          className="notification-bell-row-action"
                          onClick={() => {
                            n.action?.onClick();
                            setOpen(false);
                          }}
                        >
                          {n.action.label}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
