import { useStore } from '@/store/store';

/** Non-blocking notifications — lazy sprite fetch failures, session
 *  restore/crash-recovery notes, and (Phase 8.5 #3) a looping session's
 *  "steer" offer, which is the one case with a click action of its own.
 *  Self-dismissing; see store.ts's pushToast. */
export function Toasts(): JSX.Element | null {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dismiss(t.id)}>
          {t.text}
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
