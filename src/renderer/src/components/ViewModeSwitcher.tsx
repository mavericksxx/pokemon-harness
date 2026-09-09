import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { TreeIcon, SessionsIcon } from '@/components/icons';

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
 *  One control grammar pass — `showLabel` marks the two modes ("garden" /
 *  "terminal") that now carry a text label beside their glyph, so the
 *  segmented group reads without relying on a tooltip; "⛶" (gardenFull)
 *  stays icon-only (a full-bleed toggle needs no name, and adding one here
 *  would make the group's narrowest, least-used button its widest).
 *
 *  "All sessions" (▦) LEFT this group again in the same pass — it opens an
 *  overlay, it was never a fourth exclusive view mode, and folding it into
 *  the segmented control read as one. It renders as a standalone level-2
 *  ghost button just after the group instead (still owned by this
 *  component, so it stays reachable — there's no keyboard shortcut for
 *  `setSessionsOverviewOpen`). Every icon here is icon-only (or icon-plus-
 *  label), so every one still carries a `.tip`/`data-tip` tooltip spelling
 *  out what it does in words.
 *
 *  The terminal-panel show/hide toggle that used to live here (parity sweep,
 *  a prior pass) is gone as of item 4's fix — user report: a lone topbar
 *  icon was too easy to lose track of, and losing the terminal pane read as
 *  losing the split view entirely. It's replaced by an in-place `«`/`»` tab
 *  riding the garden/terminal divider itself (GardenSplitHandle.tsx) or
 *  docked to the row's edge when the pane is hidden (GardenDrawerEdgeTab.tsx)
 *  — right where the pane actually is, so hiding and unhiding is one obvious
 *  click instead of a hunt through the topbar. `drawerOpen`/`setDrawerOpen`
 *  (store.ts) are untouched — TerminalDrawer.tsx's own `×` in `.drawer-head`
 *  still uses them too. */
const MODES: { mode: ViewMode; label: string; glyph?: string; key: string; showLabel?: boolean }[] = [
  { mode: 'garden', label: 'garden view', key: '1', showLabel: true },
  { mode: 'terminal', label: 'terminal view', glyph: '☰', key: '2', showLabel: true },
  { mode: 'gardenFull', label: 'garden only — no chrome', glyph: '⛶', key: '3' }
];

export function ViewModeSwitcher(): JSX.Element {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const setSessionsOverviewOpen = useStore((s) => s.setSessionsOverviewOpen);

  return (
    <>
      <div className="view-switcher" role="group" aria-label="view mode">
        {MODES.map(({ mode, label, glyph, key, showLabel }) => (
          <button
            key={mode}
            className={mode === viewMode ? 'view-switcher-btn active tip' : 'view-switcher-btn tip'}
            onClick={() => setViewMode(mode)}
            data-tip={`${label} (⌘${key})`}
            aria-label={label}
            aria-pressed={mode === viewMode}
          >
            {glyph ?? <TreeIcon />}
            {showLabel && mode}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="topbar-icon-btn tip"
        data-tip="all sessions"
        aria-label="all sessions"
        onClick={() => setSessionsOverviewOpen(true)}
      >
        <SessionsIcon />
      </button>
    </>
  );
}
