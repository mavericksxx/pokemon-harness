import { useEffect, useState } from 'react';
import { GardenScene } from '@/scene/garden/GardenScene';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { GardenSplitHandle } from '@/components/GardenSplitHandle';
import { GardenDrawerEdgeTab } from '@/components/GardenDrawerEdgeTab';
import { RosterStrip } from '@/components/RosterStrip';
import { SessionsOverview } from '@/components/SessionsOverview';
import { ViewModeSwitcher } from '@/components/ViewModeSwitcher';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { SummonArceusDialog } from '@/components/SummonArceusDialog';
import { WelcomeDialog } from '@/components/WelcomeDialog';
import { PokeballIcon, DoubleChevronLeftIcon, DoubleChevronRightIcon } from '@/components/icons';
import { Toasts } from '@/components/Toasts';
import { UsageChip } from '@/components/UsageChip';
import { HarnessInstructionsChip } from '@/components/HarnessInstructionsChip';
import { AudioPopover } from '@/components/AudioPopover';
import { NotificationBell } from '@/components/NotificationBell';
import { QuickSettings } from '@/components/QuickSettings';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SettingsPanel } from '@/components/SettingsPanel';
import { QuitDialog } from '@/components/QuitDialog';
import { PokeAskModal } from '@/components/PokeAskModal';
import { BootWipe } from '@/components/BootWipe';
import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { useEffectiveLayout } from '@/effectiveLayout';
import { NARROW_LAYOUT_MAX_PX } from '@/gardenSplit';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

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
  // First-launch welcome dialog (BACKLOG item 2) — `onboardingDone` also
  // gates boot's auto-summon (main.tsx), so this dialog and a silent
  // Arceus reappearance never race. `welcomeArceusDialogOpen` is a SEPARATE
  // mount of SummonArceusDialog from ArceusRosterCard's own (that one's
  // local state stays untouched) — the welcome flow's "summon arceus"
  // button needs to open it without going through his rail card.
  const onboardingDone = useAppSettingsStore((s) => s.settings.onboardingDone);
  const [welcomeArceusDialogOpen, setWelcomeArceusDialogOpen] = useState(false);
  const viewMode = useStore((s) => s.viewMode);
  // Still needed here for the split handle's mount condition, and now the
  // restored hide-terminal chevron below too — the show-terminal half of
  // this toggle lives on GardenDrawerEdgeTab.tsx, but the divider only
  // exists when the drawer is actually showing.
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  // The drawer never opens for Arceus in 'garden' mode regardless of
  // `drawerOpen` (effectiveLayout.ts) — so its two toggle affordances below
  // (the topbar chevron, GardenDrawerEdgeTab) are hidden for him too, rather
  // than dangling controls that flip a preference with no visible effect
  // until the user switches away from him.
  const arceusSelected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  const setViewMode = useStore((s) => s.setViewMode);
  const isFullScreen = useStore((s) => s.isFullScreen);
  const setNarrowLayout = useStore((s) => s.setNarrowLayout);
  const railCollapsed = useStore((s) => s.railCollapsed);

  // Narrow-layout signal (issue #2 pt.1 + narrow-window support) — a single
  // `matchMedia` listener, not a `ResizeObserver`: collapsing the garden
  // pane below changes PANE widths, not the WINDOW's, so there's no
  // feedback-loop risk a `ResizeObserver` on an inner pane would have, and
  // this only fires once at the threshold crossing rather than on every
  // pixel. Wired once here alongside the store's own initial `matchMedia`
  // read (store.ts's `loadNarrowLayout`) so the two never disagree.
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${NARROW_LAYOUT_MAX_PX}px)`);
    const onChange = (e: MediaQueryListEvent): void => setNarrowLayout(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [setNarrowLayout]);

  // Global Cmd/Ctrl+1..4 (discoverable copy also lives in ViewModeSwitcher's
  // tooltips). Ctrl on top of Cmd so it also works un-remapped on Linux/Win,
  // even though this app currently only ships for macOS.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) {
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
  // visibility changes. `.garden-column` is a real box (not `display:
  // contents`) purely so toggling its OWN `display` (flex when shown, none
  // when hidden) can hide it without ever unmounting/remounting GardenScene.
  // `gardenVisible`/`splitActive` come from effectiveLayout.ts (the one
  // shared place `viewMode`/`drawerOpen`/`narrowLayout` are combined) —
  // below `NARROW_LAYOUT_MAX_PX`, 'garden' mode's split collapses to
  // whichever single pane `drawerOpen` currently prefers, so `gardenVisible`
  // is no longer simply "viewMode is 'garden' or 'gardenFull'".
  const { gardenVisible, splitActive } = useEffectiveLayout();
  // Party-rail rework: the roster strip (RosterStrip.tsx) used to be a
  // `.garden-column` child, present in 'garden' mode only ('terminal' had
  // its own separate sidebar, FocusSidebar.tsx; 'gardenFull' kept the
  // topbar's session chips instead). It's now a fixed-width `.body-row`
  // child of its OWN, rendered below in 'garden' and 'terminal' — replacing
  // both of those and absorbing the topbar's chips for them — but NOT in
  // 'gardenFull': that mode's own ViewModeSwitcher entry is labelled "garden
  // only — no chrome", and a permanent 200px rail is chrome. This means
  // gardenFull has no roster surface and no Arceus card at all (deliberate —
  // ⌘1/⌘2 is the way back to a mode where either is reachable; NOT a gap to
  // patch with a floating overlay or a mini-roster).
  const showRosterRail = viewMode === 'garden' || viewMode === 'terminal';
  // The topbar's own "+ new agent" button is redundant with the party
  // rail's footer whenever a view mode's rail is at its full 200px width
  // ('garden'/'terminal' — 'gardenFull' keeps it, same as before the rail
  // existed, since a full-bleed garden has no other chrome at all).
  const hideTopbarNewAgentButton = viewMode === 'garden' || viewMode === 'terminal';

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
        {/* Arceus's topbar chip (SummonArceusButton) is retired — the party
            rail (RosterStrip.tsx) guarantees his own permanent card in
            EVERY view mode now, so his summon flow lives there instead
            (ArceusRosterCard.tsx). */}
        {!hideTopbarNewAgentButton && (
          <button
            type="button"
            className="primary new-agent-button tip"
            data-tip="new agent"
            aria-label="new agent"
            onClick={() => setDialogOpen(true)}
          >
            <span className="new-agent-label">+ new agent</span>
            <span className="new-agent-icon" aria-hidden="true">
              +
            </span>
          </button>
        )}
        <div className="spacer" />
        {/* Right-cluster (topbar overhaul, BACKLOG.md phase B; one control
            grammar pass) — pinned via `.topbar-actions` (index.css) so only
            the spacer/chip rows before it absorb width changes; this group
            never reflows. Four zones, left to right: "stage" (view-mode
            group + the standalone "all sessions" button, both rendered by
            ViewModeSwitcher — see its own comment for why "all sessions"
            isn't a fourth exclusive mode), "garden picker + harness.md"
            (WorkspaceSwitcher — parity with the other state-holding/action
            controls in this cluster — plus HarnessInstructionsChip),
            "budget gauges" (UsageChip — a level-3 gauge, so it's a bare
            child here with no zone wrapper: "no container at all, ever" per
            the grammar, and it can render null so a wrapper would leave a
            stray empty gap), and "system icons" (audio/bell/theme/gear/
            hide-terminal). `.topbar-zone` + `.topbar-actions`'s own gap
            (index.css) give the 4px-inside/12px-between-groups rhythm; the
            garden and system zones each add a hairline rule via their own
            `border-left`.
            The hide-terminal chevron below is the restored other half of
            GardenDrawerEdgeTab.tsx's show-terminal tab (that one only
            covers bringing the drawer BACK once it's closed — this is what
            closes it in the first place), rendered only in 'garden' mode
            where the split actually exists; level-2 ghost `.topbar-icon-btn`,
            same weight as its audio/bell/theme/gear neighbors. */}
        <div className="topbar-actions">
          <div className="topbar-zone topbar-zone-stage">
            <ViewModeSwitcher />
          </div>
          <div className="topbar-zone topbar-zone-garden">
            <WorkspaceSwitcher />
            <HarnessInstructionsChip />
          </div>
          <UsageChip />
          <div className="topbar-zone topbar-zone-system">
            <AudioPopover />
            <NotificationBell />
            <ThemeToggle />
            <QuickSettings />
            {viewMode === 'garden' && !arceusSelected && (
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
        </div>
      </header>

      <main className="body">
        <div className={`body-row${showRosterRail && railCollapsed ? ' rail-collapsed' : ''}`}>
          {/* Party rail — a fixed-width `.body-row` child of its own, first
              so it reads as the app's one permanent left rail. Shown in
              'garden' and 'terminal' only (see `showRosterRail`'s own
              comment above for why 'gardenFull' — a deliberately chrome-
              free mode — is excluded); simply omitting it here is enough to
              give `.garden-column` the row's full width in that mode, no
              extra CSS needed (it's already a flex child with no rail
              sibling to share space with). `rail-collapsed` here (not on
              `.party-rail` itself) is what actually shrinks `.garden-column`/
              `.drawer` to fill the reclaimed space — it flips the same
              `--party-rail-w` custom property gardenSplit.ts's
              `terminalWidthCss` already reads, same mechanism the
              `@media (max-width: 1100px)` auto-collapse uses (index.css),
              just JS-driven instead of viewport-driven. RosterStrip reads
              `railCollapsed`/`setRailCollapsed` off the store itself (same
              as `viewMode`/`collapsedParentIds` etc. there) rather than
              through props — this is the only other place that needs the
              value, to keep `.garden-column`/`.drawer` in sync. */}
          {showRosterRail && <RosterStrip onNewSession={() => setDialogOpen(true)} />}
          <div
            className="garden-column"
            data-view-mode={viewMode}
            style={{ display: gardenVisible ? 'flex' : 'none' }}
          >
            <GardenScene />
          </div>
          {/* Draggable garden/terminal divider — 'garden' view mode's
              side-by-side layout only ('terminal'/'gardenFull' have no
              split, and a hidden drawer has nothing to divide). See
              gardenSplit.ts for the persisted ratio/clamps and index.css's
              "garden/terminal split divider" block for its styling. */}
          {splitActive && <GardenSplitHandle />}
          {/* Parity sweep item 4 — the "bring it back" half of the same
              toggle, docked to the row's own edge while there's no divider
              to ride (see GardenDrawerEdgeTab.tsx's own header). The other
              half — closing it in the first place — is the topbar's
              restored hide-terminal chevron above. */}
          {viewMode === 'garden' && !drawerOpen && !arceusSelected && <GardenDrawerEdgeTab />}
          <TerminalDrawer />
        </div>
      </main>

      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
      <SessionsOverview />
      <SettingsPanel />
      <QuitDialog />
      <PokeAskModal />
      {!onboardingDone && <WelcomeDialog onSummonArceus={() => setWelcomeArceusDialogOpen(true)} />}
      {welcomeArceusDialogOpen && (
        <SummonArceusDialog onClose={() => setWelcomeArceusDialogOpen(false)} />
      )}
      <Toasts />
      <BootWipe />
    </div>
  );
}
