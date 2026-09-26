import { useEffect, useState } from 'react';
import { isPending, subscribePending, manualReload } from '@/outsideWriteGate';

/**
 * External sessions plan §7 step 5 — "Updated elsewhere — reload" chip for a
 * `continuedFrom` session whose transcript changed from outside while the
 * idle gate was closed (see outsideWriteGate.ts). Same "small, hover-
 * findable pill" shape the old `StaleArgvChip.tsx` used for the (since
 * reverted) stale-argv restart action.
 */
export function OutsideWriteChip({ sessionId }: { sessionId: string }): JSX.Element | null {
  const [pending, setPendingState] = useState(() => isPending(sessionId));
  const [reloading, setReloading] = useState(false);

  useEffect(() => subscribePending(() => setPendingState(isPending(sessionId))), [sessionId]);

  if (!pending) return null;

  return (
    <button
      type="button"
      className="tip roster-card-outside-write-chip"
      data-tip="another surface (Desktop or the plain CLI) added to this conversation — reload to catch up"
      aria-label="updated elsewhere — reload"
      disabled={reloading}
      onClick={async (e) => {
        e.stopPropagation();
        setReloading(true);
        await manualReload(sessionId);
        setReloading(false);
      }}
    >
      {reloading ? 'reloading…' : 'updated elsewhere — reload'}
    </button>
  );
}
