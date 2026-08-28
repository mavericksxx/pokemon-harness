import { useState } from 'react';
import { useStore } from '@/store/store';
import { arceusIsLive, autoSummonArceus, selectArceus } from '@/arceus';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { SummonArceusDialog } from '@/components/SummonArceusDialog';

/** Topbar "summon Arceus" action (Phase 8.8 §1, summon-once behavior added
 *  Phase 8.9) — always visible (Arceus is global, not scoped to whichever
 *  view mode/workspace is showing).
 *
 *  Live already: selects him instead of reopening the dialog, so "at most
 *  ONE Arceus" holds at the UI layer too. Not live: this must NEVER reopen
 *  the setup dialog while a saved config exists (agents/arceus/summon.json)
 *  — it auto-summons from that config instead, same as launch does. The
 *  dialog is reserved for a genuine first run (or after Settings' reset
 *  action deletes that file) — `autoSummonArceus`'s `'no-config'` outcome is
 *  exactly that signal. */
export function SummonArceusButton(): JSX.Element {
  const live = useStore((s) => {
    const a = s.sessions.find((x) => x.id === ARCEUS_SESSION_ID);
    return !!a && a.status !== 'done';
  });
  const selected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  const pushToast = useStore((s) => s.pushToast);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [summoning, setSummoning] = useState(false);

  const onClick = async (): Promise<void> => {
    if (arceusIsLive()) {
      selectArceus();
      return;
    }
    if (summoning) return;
    setSummoning(true);
    const outcome = await autoSummonArceus();
    setSummoning(false);
    if (outcome === 'no-config') setDialogOpen(true);
    else if (outcome === 'failed') pushToast("arceus couldn't return — click his chip to re-summon.");
  };

  return (
    <>
      <button
        type="button"
        className={selected && live ? 'summon-arceus active' : 'summon-arceus'}
        title={live ? 'select Arceus' : 'summon Arceus'}
        disabled={summoning}
        onClick={() => void onClick()}
      >
        <span className="summon-arceus-glyph" aria-hidden="true">
          ✦
        </span>
        {summoning ? 'summoning…' : 'arceus'}
      </button>
      {dialogOpen && <SummonArceusDialog onClose={() => setDialogOpen(false)} />}
    </>
  );
}
