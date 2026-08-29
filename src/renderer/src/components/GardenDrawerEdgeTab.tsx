import { useStore } from '@/store/store';
import { DoubleChevronLeftIcon } from '@/components/icons';

/** Parity sweep item 4 — the "show terminal" half of the garden-split
 *  toggle, docked to `.body-row`'s own right edge. Rendered by App.tsx ONLY
 *  in 'garden' view mode while the drawer is closed (the open-state half of
 *  this same toggle rides the divider itself instead — see
 *  GardenSplitHandle.tsx's own `.garden-split-collapse-tab` — which isn't
 *  mounted at all while the drawer is closed, so the two tabs never
 *  overlap). Discoverability was the whole point here (user report: the
 *  topbar's own show/hide icon was easy to lose track of, and losing the
 *  terminal pane read as losing the split view entirely) — an edge tab
 *  sitting right where the pane used to be is the obvious "it's still
 *  there, click to bring it back" affordance a topbar icon can't be. */
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
