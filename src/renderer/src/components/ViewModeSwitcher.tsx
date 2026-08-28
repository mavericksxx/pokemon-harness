import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { TreeIcon, TerminalPanelIcon, SessionsIcon } from '@/components/icons';

/** Phase 8 §1 — three layouts, each with a discoverable chrome toggle AND a
 *  Cmd+1..3 shortcut (bound globally in App.tsx). Order here matches the
 *  shortcut numbers. `glyph` is a plain character for the two that already
 *  render as monochrome text symbols (☰ ⛶ — verified against rendered
 *  screenshots, not emoji-range membership); 'garden' was U+1F332 EVERGREEN
 *  TREE (a genuine color emoji) and renders via TreeIcon (icons.tsx)
 *  instead, as of the ship-cut emoji purge.
 *
 *  Was four modes/buttons — 'terminalFull' (▣) dropped (user report: read as
 *  a duplicate of 'terminal'/☰, since both hide the garden and give the
 *  terminal the whole body; the only difference was where session-switching
 *  UI lived). 'terminal' is the one kept — see store.ts's ViewMode comment.
 *
 *  Two more icons joined this group in the topbar-consolidation pass (parity
 *  sweep): the terminal-panel show/hide toggle (was a standalone "hide
 *  terminal" text button, inconsistent with everything else here being an
 *  icon toggle) and "all sessions" (was a standalone labeled button floating
 *  next to this group). Every icon here is icon-only, so every one carries a
 *  `.tip`/`data-tip` tooltip spelling out what it does in words — this group
 *  is the one place in the topbar where a glyph alone has to stand in for a
 *  whole action. */
const MODES: { mode: ViewMode; label: string; glyph?: string; key: string }[] = [
  { mode: 'garden', label: 'garden view', key: '1' },
  { mode: 'terminal', label: 'terminal view', glyph: '☰', key: '2' },
  { mode: 'gardenFull', label: 'garden only — no chrome', glyph: '⛶', key: '3' }
];

export function ViewModeSwitcher(): JSX.Element {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const setSessionsOverviewOpen = useStore((s) => s.setSessionsOverviewOpen);

  /** Only meaningful in 'garden' mode (the drawer is always open in
   *  'terminal' and never shown in 'gardenFull' — TerminalDrawer.tsx's own
   *  `open` calc). Rendered disabled rather than unmounted outside it — an
   *  unmounted button changed the group's button count (4 vs 5), which
   *  resized the whole group and shifted the topbar-actions cluster next to
   *  it. Kept clickable (no-op) rather than the native `disabled` attribute
   *  so the `.tip` tooltip — which relies on :hover/:focus-visible, neither
   *  of which fire on a disabled control — still explains itself. */
  const drawerToggleAvailable = viewMode === 'garden';

  return (
    <div className="view-switcher" role="group" aria-label="view mode">
      {MODES.map(({ mode, label, glyph, key }) => (
        <button
          key={mode}
          className={
            mode === viewMode
              ? 'topbar-icon-btn view-switcher-btn active tip'
              : 'topbar-icon-btn view-switcher-btn tip'
          }
          onClick={() => setViewMode(mode)}
          data-tip={`${label} (⌘${key})`}
          aria-label={label}
          aria-pressed={mode === viewMode}
        >
          {glyph ?? <TreeIcon />}
        </button>
      ))}
      <button
        type="button"
        className={
          !drawerToggleAvailable
            ? 'topbar-icon-btn view-switcher-btn view-switcher-btn-unavailable tip'
            : drawerOpen
              ? 'topbar-icon-btn view-switcher-btn active tip'
              : 'topbar-icon-btn view-switcher-btn tip'
        }
        data-tip={drawerToggleAvailable ? 'show/hide terminal panel' : 'terminal panel (garden view only)'}
        aria-label="show/hide terminal panel"
        aria-pressed={drawerToggleAvailable && drawerOpen}
        aria-disabled={!drawerToggleAvailable}
        onClick={() => drawerToggleAvailable && setDrawerOpen(!drawerOpen)}
      >
        <TerminalPanelIcon />
      </button>
      <button
        type="button"
        className="topbar-icon-btn view-switcher-btn tip"
        data-tip="all sessions"
        aria-label="all sessions"
        onClick={() => setSessionsOverviewOpen(true)}
      >
        <SessionsIcon />
      </button>
    </div>
  );
}
