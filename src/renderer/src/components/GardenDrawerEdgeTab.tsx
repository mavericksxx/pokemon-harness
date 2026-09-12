import { useStore } from '@/store/store';
import { DoubleChevronLeftIcon } from '@/components/icons';

/** Parity sweep item 4 — the "show terminal" half of the garden-split
 *  toggle, docked to `.body-row`'s own right edge. Rendered by App.tsx ONLY
 *  in 'garden' view mode while the drawer is closed AND Arceus isn't the
 *  selected session (his drawer never opens regardless of this toggle —
 *  see effectiveLayout.ts — so this affordance would otherwise do nothing
 *  visible for him) — the "hide terminal" half lives back in the topbar
 *  instead (App.tsx's `.topbar-icon-btn` in the system zone, same Arceus
 *  exclusion), since this tab has nowhere to dock once the drawer
 *  (and the divider it would otherwise ride) is gone. Discoverability was
 *  the whole point of adding this half here (user report: the topbar's own
 *  show/hide icon was easy to lose track of, and losing the terminal pane
 *  read as losing the split view entirely) — an edge tab sitting right
 *  where the pane used to be is the obvious "it's still there, click to
 *  bring it back" affordance a topbar icon can't be on its own. */
export function GardenDrawerEdgeTab(): JSX.Element {
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);

  return (
    <button
      type="button"
      className="garden-drawer-edge-tab tip"
      data-tip="show terminal"
      aria-label="show terminal panel"
      onClick={() => setDrawerOpen(true)}
    >
      <DoubleChevronLeftIcon />
    </button>
  );
}
