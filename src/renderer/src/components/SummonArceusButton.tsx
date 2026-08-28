import { useState } from 'react';
import { useStore } from '@/store/store';
import { arceusIsLive, selectArceus } from '@/arceus';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { SummonArceusDialog } from '@/components/SummonArceusDialog';

/** Topbar "summon Arceus" action (Phase 8.8 §1) — always visible (Arceus is
 *  global, not scoped to whichever view mode/workspace is showing).
 *  Live already: selects him instead of reopening the dialog, so "at most
 *  ONE Arceus" holds at the UI layer too. */
export function SummonArceusButton(): JSX.Element {
  const live = useStore((s) => {
    const a = s.sessions.find((x) => x.id === ARCEUS_SESSION_ID);
    return !!a && a.status !== 'done';
  });
  const selected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={selected && live ? 'summon-arceus active' : 'summon-arceus'}
        title={live ? 'Select Arceus' : 'Summon Arceus'}
        onClick={() => (arceusIsLive() ? selectArceus() : setDialogOpen(true))}
      >
        <span className="summon-arceus-glyph" aria-hidden="true">
          ✦
        </span>
        arceus
      </button>
      {dialogOpen && <SummonArceusDialog onClose={() => setDialogOpen(false)} />}
    </>
  );
}
