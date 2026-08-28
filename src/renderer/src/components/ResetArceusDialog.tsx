import { useState } from 'react';
import { resetArceusSummonConfig } from '@/arceus';

interface Props {
  onClose(): void;
}

/** Settings' "reset arceus" confirm (Phase 8.9) — styled like
 *  DeleteWorkspaceDialog (warm copy, a plain "cancel" beside a `.danger`
 *  destructive action). Deletes agents/arceus/summon.json, the file whose
 *  mere existence gates the summon dialog (SummonArceusButton) — this is
 *  the only UI path back to first-run behavior short of wiping the harness
 *  home folder by hand. Does NOT touch a currently-live Arceus session, if
 *  any; it only means the NEXT time he isn't live, the setup dialog shows
 *  again instead of a silent auto-summon. */
export function ResetArceusDialog({ onClose }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    await resetArceusSummonConfig();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>reset arceus?</h2>
        <p className="hint">
          Forgets his saved summon setup. Next time he isn&apos;t live, you&apos;ll get the setup dialog again instead
          of him just returning on his own. A currently-live Arceus session isn&apos;t affected.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            cancel
          </button>
          <button type="button" className="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'resetting…' : 'reset arceus'}
          </button>
        </div>
      </div>
    </div>
  );
}
