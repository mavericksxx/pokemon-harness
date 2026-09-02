import { useEffect, useState } from 'react';
import { GardenScene } from '@/scene/garden/GardenScene';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { GardenSplitHandle } from '@/components/GardenSplitHandle';
import { GardenDrawerEdgeTab } from '@/components/GardenDrawerEdgeTab';
import { RosterStrip } from '@/components/RosterStrip';
import { FocusSidebar } from '@/components/FocusSidebar';
import { SessionsOverview } from '@/components/SessionsOverview';
import { ViewModeSwitcher } from '@/components/ViewModeSwitcher';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { SummonArceusButton } from '@/components/SummonArceusButton';
import { DoubleChevronLeftIcon, DoubleChevronRightIcon, PokeballIcon, TerminalIcon } from '@/components/icons';
import { PokemonFace } from '@/components/PokemonFace';
import { Toasts } from '@/components/Toasts';
import { UsageChip } from '@/components/UsageChip';
import { AudioPopover } from '@/components/AudioPopover';
import { QuickSettings } from '@/components/QuickSettings';
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
import { OverflowChipRow, type OverflowChipRenderContext } from '@/components/OverflowChipRow';
import type { Session } from '@/store/store';

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

function renderSessionChip(s: Session, { selected, onSelect }: OverflowChipRenderContext): JSX.Element {
  return (
    <button
      type="button"
      className={selected ? 'chip active' : 'chip'}
      onClick={onSelect}
      title={`${s.command} — ${s.cwd}`}
    >
      {s.isPlainTerminal ? (
        <span className="terminal-session-icon terminal-session-icon-chip">
          <TerminalIcon />
        </span>
      ) : (
        <PokemonFace name={s.pokemon} shiny={s.shiny} box={22} />
      )}
      {s.shiny && (
        <span className="shiny-badge" title="shiny" aria-label="shiny">
          ★
        </span>
      )}
      <span className="chip-title">{s.title}</span>
      <em className={s.napping ? 'status napping' : `status ${s.status}`}>{sessionStatusLabel(s)}</em>
    </button>
  );
}

// Crash/reload recovery (consumeCrashInfo + restoreSessions) runs once in
// main.tsx, BEFORE this component's first render — not here — so the store
// already has any re-adopted sessions by the time GardenScene and
// TerminalDrawer mount. See main.tsx's boot().

export function App(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Legacy topbar chips (Full view modes only, below) — scoped to the
  // ACTIVE workspace (Phase 8.7), same as the roster strip/overview. Arceus
  // is excluded (his topbar chip, SummonArceusButton, is his one home) —
  // same filter as RosterStrip/SessionsOverview.
  const sessions = useActiveWorkspaceSessions().filter((s) => !s.isArceus && !(s.delegateParentId && s.status === 'done'));
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const viewMode = useStore((s) => s.viewMode);
  // Still needed here for the split handle's mount condition — the terminal
  // panel TOGGLE moved into ViewModeSwitcher, but the divider only exists
  // when the drawer is actually showing.
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const setViewMode = useStore((s) => s.setViewMode);
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
  // visibility changes. Garden-split rework: the wrapper is now `.garden-
  // column`, a real flex column (garden pane on top, roster strip directly
  // under it — 'terminal' mode never has a strip, so it's just the garden
  // pane alone there, same as before) instead of `display: contents` — it
  // has to be a real box now so it can host both children stacked. Toggling
  // its OWN `display` (flex when shown, none when hidden) still keeps
  // GardenScene at the same position in the tree across every mode switch,
  // so it's never unmounted/remounted by this.
  const gardenVisible = viewMode === 'garden' || viewMode === 'gardenFull';
  // Bottom roster strip (parity sweep item 5) — 'garden' only now. 'terminal'
  // got its own left sidebar instead (Munder Difflin restyle, FocusSidebar,
  // rendered in body-row below); 'gardenFull' keeps the previous topbar
  // chips + "+ new agent" button, unchanged: full-bleed garden has no room
  // for a strip without shrinking the thing it's meant to be full-bleed.
  //
  // Garden-split rework: moving the strip INSIDE `.garden-column` (rather
  // than below `.body-row` as a sibling) is what makes the terminal drawer
  // full-height for free — `.body` now has just one child (`.body-row`), so
  // `.body-row` claims its ENTIRE height, and `.drawer`/`.focus-sidebar`
  // (ordinary row-flex children of `.body-row`, no explicit height of their
  // own) stretch to match via that row's default `align-items: stretch` —
  // no manual height math anywhere. Same reasoning covers "terminal hidden →
  // garden + strip take the full width": with no drawer/handle/edge-tab
  // mounted, `.garden-column` is `.body-row`'s only child and its own
  // `flex: 1` already fills the row.
  const showRosterStrip = viewMode === 'garden';
  const showFocusSidebar = viewMode === 'terminal';
  // Topbar chips are hidden whenever a view mode has its own roster UI —
  // unchanged semantics from before the sidebar split ('garden' and
  // 'terminal' both had this, via the single `showRosterStrip` flag above).
  const hideTopbarChips = viewMode === 'garden' || viewMode === 'terminal';

  return (
    <div className={`app${isFullScreen ? ' is-fullscreen' : ''}`}>
      <header className="topbar">
        {/* Placeholder brand glyph ("for now") to the wordmark's left — see
            PokeballIcon's own doc comment in components/icons.tsx for why it
            breaks that file's currentColor convention. Wrapped with `.brand`
            in `.brand-lockup` (rather than relying on `.topbar`'s own 10px
            gap, which is closer to the row's item-to-item spacing than the
            tighter icon-to-its-own-label spacing this needs) so both are one
            flex item that inherits the drag region and vertical centering
            .brand always got from being a direct .topbar child. */}
        <span className="brand-lockup">
          <PokeballIcon className="brand-icon" />
          {/* Ship-cut item 1/6: brand mark is lowercase "pokéharness" — the
              voice's own lowercase convention, extended to the one string
              that's otherwise exempt from the sweep (design/tokens.ts has the
              rule). Press Start 2P carries a real 'é' glyph (verified against
              the bundled woff2's cmap) and it reads fine at this size; if that
              ever changes, fall back to plain "pokeharness" here only — every
              other surface (README, notifications, dialogs) keeps the accent. */}
          <span className="brand">pokéharness</span>
        </span>
        {/* Arceus first (Phase 8.8/8.9/parity sweep) — he's global, not
            scoped to any one garden, so his chip leads the workspace row
            rather than sitting inside it. */}
        <SummonArceusButton />
        <WorkspaceSwitcher />
        {!hideTopbarChips && (
          <>
            <button className="primary" onClick={() => setDialogOpen(true)}>
              + new agent
            </button>
            <OverflowChipRow
              items={sessions}
              selectedId={selectedId}
              getItemId={(s) => s.id}
              onRowSelect={(s) => select(s.id === selectedId ? null : s.id)}
              onMenuSelect={(s) => select(s.id)}
              renderItem={renderSessionChip}
              wrapperClassName="session-chips-wrap"
              rowClassName="session-chips"
              fadeClassName="session-chips-fade"
              menuAriaLabel="sessions"
            />
          </>
        )}
        <div className="spacer" />
        {/* Right-cluster (topbar overhaul, BACKLOG.md phase B) — pinned via
            `.topbar-actions` (index.css) so only the spacer/chip rows before
            it absorb width changes; this group never reflows. View-mode
            toggles, terminal-panel visibility, and the sessions overview
            live together as one icon group (parity sweep) — see
            ViewModeSwitcher's own comment for why "all sessions" and the
            terminal-panel toggle joined it instead of floating separately.
            QuickSettings is the settings entry point itself (its gear
            trigger opens the quick-settings popover, whose "all settings…"
            row opens SettingsPanel; the old standalone gear button that
            opened SettingsPanel directly is gone, merged into this one). The
            garden-only terminal visibility toggle sits immediately to its
            right. */}
        <div className="topbar-actions">
          <ViewModeSwitcher />
          <UsageChip />
          <AudioPopover />
          <ThemeToggle />
          <QuickSettings />
          {viewMode === 'garden' && (
            <button
              type="button"
              className="topbar-icon-btn tip"
              data-tip={drawerOpen ? 'hide terminal' : 'show terminal'}
              aria-label={drawerOpen ? 'hide terminal' : 'show terminal'}
              aria-pressed={drawerOpen}
              onClick={() => setDrawerOpen(!drawerOpen)}
            >
              {drawerOpen ? <DoubleChevronRightIcon /> : <DoubleChevronLeftIcon />}
            </button>
          )}
        </div>
      </header>

      <main className="body">
        <div className="body-row">
          <div className="garden-column" style={{ display: gardenVisible ? 'flex' : 'none' }}>
            <GardenScene />
            {showRosterStrip && <RosterStrip onNewSession={() => setDialogOpen(true)} />}
          </div>
          {/* Draggable garden/terminal divider — 'garden' view mode's
              side-by-side layout only ('terminal'/'gardenFull' have no
              split, and a hidden drawer has nothing to divide). See
              gardenSplit.ts for the persisted ratio/clamps and index.css's
              "garden/terminal split divider" block for its styling. */}
          {viewMode === 'garden' && drawerOpen && <GardenSplitHandle />}
          {/* Parity sweep item 4 — the "bring it back" half of the same
              toggle, docked to the row's own edge while there's no divider
              to ride (see GardenDrawerEdgeTab.tsx's own header). */}
          {viewMode === 'garden' && !drawerOpen && <GardenDrawerEdgeTab />}
          {showFocusSidebar && <FocusSidebar onNewSession={() => setDialogOpen(true)} />}
          <TerminalDrawer />
        </div>
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
