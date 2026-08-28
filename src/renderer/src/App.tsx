import { useEffect, useState } from 'react';
import { GardenScene } from '@/scene/garden/GardenScene';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { RosterStrip } from '@/components/RosterStrip';
import { SessionsOverview } from '@/components/SessionsOverview';
import { ViewModeSwitcher } from '@/components/ViewModeSwitcher';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { SummonArceusButton } from '@/components/SummonArceusButton';
import { PokemonFace } from '@/components/PokemonFace';
import { Toasts } from '@/components/Toasts';
import { AudioPopover } from '@/components/AudioPopover';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SettingsPanel } from '@/components/SettingsPanel';
import { QuitDialog } from '@/components/QuitDialog';
import { BootWipe } from '@/components/BootWipe';
import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { cancelClosingTime, isClosingTimeActive, startClosingTime } from '@/closingTime';

/** Cmd/Ctrl+1..3 → the three view modes, matching ViewModeSwitcher's order.
 *  Bound globally (not per-input) — none of the app's text inputs use
 *  digit-only shortcuts, and Cmd is never a plain typing key. */
const SHORTCUT_MODES: Record<string, ViewMode> = {
  '1': 'garden',
  '2': 'terminal',
  '3': 'gardenFull'
};

/** Cmd/Ctrl+Shift+1..9 → switch to the Nth workspace, in registry order
 *  (Phase 8.7) — matched off `e.code` ('Digit1'..'Digit9'), not `e.key`:
 *  with Shift held, `e.key` for the number row is '!'/'@'/'#'/... on a US
 *  layout, which would never match a plain digit lookup like
 *  SHORTCUT_MODES does above. */
const DIGIT_CODE_RE = /^Digit([1-9])$/;

// Crash/reload recovery (consumeCrashInfo + restoreSessions) runs once in
// main.tsx, BEFORE this component's first render — not here — so the store
// already has any re-adopted sessions by the time GardenScene and
// TerminalDrawer mount. See main.tsx's boot().

export function App(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Legacy topbar chips (Full view modes only, below) — scoped to the
  // ACTIVE workspace (Phase 8.7), same as the roster strip/overview.
  const sessions = useActiveWorkspaceSessions();
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const setSessionsOverviewOpen = useStore((s) => s.setSessionsOverviewOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const isFullScreen = useStore((s) => s.isFullScreen);

  // Global Cmd/Ctrl+1..4 (discoverable copy also lives in ViewModeSwitcher's
  // tooltips). Ctrl on top of Cmd so it also works un-remapped on Linux/Win,
  // even though this app currently only ships for macOS. Also: Cmd/Ctrl+
  // Shift+Q starts the closing-time ritual (Phase 8.5 Wave B item 2), and a
  // bare Escape cancels it — checked here, not inside closingTime.ts, so it
  // only fires while THIS app has focus, same as every other global shortcut
  // in this effect. SettingsPanel's own Escape handler is neutralized by
  // startClosingTime() closing that panel up front (see that function's own
  // comment), so this is the only live Escape handler once a ritual starts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isClosingTimeActive()) {
        e.preventDefault();
        cancelClosingTime();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) {
        if (e.key.toLowerCase() === 'q') {
          e.preventDefault();
          startClosingTime();
          return;
        }
        // Cmd/Ctrl+Shift+1..9 — switch workspace (Phase 8.7). Reads the
        // workspace store directly (not a hook) since this effect has no
        // reason to re-subscribe to the workspace list just for a shortcut.
        const digitMatch = DIGIT_CODE_RE.exec(e.code);
        if (digitMatch) {
          const target = useWorkspaceStore.getState().workspaces[Number(digitMatch[1]) - 1];
          if (target) {
            e.preventDefault();
            void useWorkspaceStore.getState().setActiveWorkspace(target.id);
          }
          return;
        }
        return;
      }
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
  // participates in `.body-row`'s flex layout as if this wrapper weren't
  // there.
  const gardenVisible = viewMode === 'garden' || viewMode === 'gardenFull';
  // Bottom roster strip (parity sweep item 5) — 'garden' and 'terminal' only
  // ('gardenFull' keeps the previous topbar chips + New Session button
  // below instead, unchanged: full-bleed garden has no room for a strip
  // without shrinking the thing it's meant to be full-bleed).
  const showRosterStrip = viewMode === 'garden' || viewMode === 'terminal';

  return (
    <div className={`app${isFullScreen ? ' is-fullscreen' : ''}`}>
      <header className="topbar">
        {/* Ship-cut item 1/6: brand mark is lowercase "pokéharness" — the
            voice's own lowercase convention, extended to the one string
            that's otherwise exempt from the sweep (design/tokens.ts has the
            rule). Press Start 2P carries a real 'é' glyph (verified against
            the bundled woff2's cmap) and it reads fine at this size; if that
            ever changes, fall back to plain "pokeharness" here only — every
            other surface (README, notifications, dialogs) keeps the accent. */}
        <span className="brand">pokéharness</span>
        <WorkspaceSwitcher />
        <SummonArceusButton />
        {!showRosterStrip && (
          <>
            <button className="primary" onClick={() => setDialogOpen(true)}>
              + new session
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
                    <span className="shiny-badge" title="shiny" aria-label="shiny">
                      ★
                    </span>
                  )}
                  <span className="chip-title">{s.title}</span>
                  <em className={s.napping ? 'status napping' : `status ${s.status}`}>{sessionStatusLabel(s)}</em>
                </button>
              ))}
            </nav>
          </>
        )}
        <div className="spacer" />
        {/* Kept unconditionally (deviates from the strip-mode topbar's
            otherwise-minimal set) — the garden's own signpost prop opens the
            same overview, but it's unreachable while the garden is hidden
            ('terminal' mode), so dropping this here would strand the
            sessions-overview feature in that mode. */}
        <button title="all sessions" aria-label="all sessions" onClick={() => setSessionsOverviewOpen(true)}>
          sessions
        </button>
        <ViewModeSwitcher />
        <AudioPopover />
        <ThemeToggle />
        <button className="tip" data-tip="settings" aria-label="settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {viewMode === 'garden' && (
          <button onClick={() => setDrawerOpen(!drawerOpen)}>{drawerOpen ? 'hide terminal' : 'show terminal'}</button>
        )}
      </header>

      <main className="body">
        <div className="body-row">
          <div style={{ display: gardenVisible ? 'contents' : 'none' }}>
            <GardenScene />
          </div>
          <TerminalDrawer />
        </div>
        {showRosterStrip && <RosterStrip onNewSession={() => setDialogOpen(true)} />}
      </main>

      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
      <SessionsOverview />
      <SettingsPanel />
      <QuitDialog />
      <Toasts />
      <BootWipe />
    </div>
  );
}
