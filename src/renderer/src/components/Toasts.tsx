import { useStore } from '@/store/store';

/** Non-blocking notifications — currently just lazy sprite fetch failures
 *  (offline/404): the walker still gets a pokeball placeholder, this is only
 *  the "here's why" note. Self-dismissing; see store.ts's pushToast. */
export function Toasts(): JSX.Element | null {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
