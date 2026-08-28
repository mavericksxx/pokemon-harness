import { useEffect, useState } from 'react';
import { GardenScene } from '@/scene/garden/GardenScene';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { SessionSidebar } from '@/components/SessionSidebar';
import { SessionsOverview } from '@/components/SessionsOverview';
import { ViewModeSwitcher } from '@/components/ViewModeSwitcher';
import { PokemonFace } from '@/components/PokemonFace';
import { Toasts } from '@/components/Toasts';
import { QuickMute } from '@/components/QuickMute';
import { SettingsPanel } from '@/components/SettingsPanel';
import { BootWipe } from '@/components/BootWipe';
import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';

/** Cmd/Ctrl+1..4 → the four Phase 8 §1 view modes, matching ViewModeSwitcher's
 *  order. Bound globally (not per-input) — none of the app's text inputs use
 *  digit-only shortcuts, and Cmd is never a plain typing key. */
const SHORTCUT_MODES: Record<string, ViewMode> = {
  '1': 'garden',
  '2': 'terminal',
  '3': 'gardenFull',
  '4': 'terminalFull'
};

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
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const setSessionsOverviewOpen = useStore((s) => s.setSessionsOverviewOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  // Global Cmd/Ctrl+1..4 (discoverable copy also lives in ViewModeSwitcher's
  // tooltips). Ctrl on top of Cmd so it also works un-remapped on Linux/Win,
  // even though this app currently only ships for macOS.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const mode = SHORTCUT_MODES[e.key];
      if (!mode) return;
      e.preventDefault();
      setViewMode(mode);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setViewMode]);

  // Garden stays mounted across every mode (Pixi teardown/rebuild is
  // expensive and would drop the running simulation) — only its layout
  // visibility changes. `display: contents` when shown so it still
  // participates in `.body`'s flex layout as if this wrapper weren't there.
  const gardenVisible = viewMode === 'garden' || viewMode === 'gardenFull';
  const showSidebar = viewMode === 'terminal';

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
        <button title="All sessions" aria-label="All sessions" onClick={() => setSessionsOverviewOpen(true)}>
          Sessions
        </button>
        <ViewModeSwitcher />
        <QuickMute />
        <button title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {viewMode === 'garden' && (
          <button onClick={() => setDrawerOpen(!drawerOpen)}>{drawerOpen ? 'Hide terminal' : 'Show terminal'}</button>
        )}
      </header>

      <main className="body">
        <div style={{ display: gardenVisible ? 'contents' : 'none' }}>
          <GardenScene />
        </div>
        {showSidebar && <SessionSidebar />}
        <TerminalDrawer />
      </main>

      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
      <SessionsOverview />
      <SettingsPanel />
      <Toasts />
      <BootWipe />
    </div>
  );
}
