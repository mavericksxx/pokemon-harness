import { useState } from 'react';
import { GardenScene } from '@/scene/garden/GardenScene';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { PokemonFace } from '@/components/PokemonFace';
import { Toasts } from '@/components/Toasts';
import { AudioPopover } from '@/components/AudioPopover';
import { useStore } from '@/store/store';

// Crash/reload recovery (consumeCrashInfo + restoreSessions) runs once in
// main.tsx, BEFORE this component's first render — not here — so the store
// already has any re-adopted sessions by the time GardenScene and
// TerminalDrawer mount. See main.tsx's boot().

export function App(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">pokemon-harness</span>
        <button className="primary" onClick={() => setDialogOpen(true)}>
          + New Session
        </button>
        <nav className="session-chips">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={s.id === selectedId ? 'chip active' : 'chip'}
              onClick={() => select(s.id === selectedId ? null : s.id)}
              title={`${s.command} — ${s.cwd}`}
            >
              <PokemonFace name={s.pokemon} shiny={s.shiny} box={22} />
              {s.shiny && (
                <span className="shiny-badge" title="Shiny" aria-label="shiny">
                  ★
                </span>
              )}
              {s.title}
              <em className={`status ${s.status}`}>{s.status}</em>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <AudioPopover />
        <button onClick={() => setDrawerOpen(!drawerOpen)}>
          {drawerOpen ? 'Hide terminal' : 'Show terminal'}
        </button>
      </header>

      <main className="body">
        <GardenScene />
        <TerminalDrawer />
      </main>

      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
      <Toasts />
    </div>
  );
}
