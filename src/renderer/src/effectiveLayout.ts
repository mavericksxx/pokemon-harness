import { useStore, type ViewMode } from '@/store/store';

/** "What should actually be visible right now," combining `viewMode`,
 *  `drawerOpen`, and `narrowLayout` (store.ts) — the ONE place this
 *  combination is computed (issue #2 pt.1). App.tsx, TerminalDrawer.tsx, and
 *  GardenScene.tsx each used to work out their own slice of this
 *  independently; below `NARROW_LAYOUT_MAX_PX` (gardenSplit.ts) the
 *  garden/terminal split stops being structurally valid, so 'garden' mode
 *  now has a fourth effective shape (single-pane, whichever of the two
 *  `drawerOpen` currently prefers) on top of the three `ViewMode`s
 *  themselves — computing that in three places risked them drifting out of
 *  sync. */
export interface EffectiveLayout {
  /** Whether the garden pane (`.garden-column`, App.tsx) should be visible
   *  right now. */
  gardenVisible: boolean;
  /** Whether the terminal drawer should render full-bleed (`.drawer-wide`)
   *  rather than the split's clamped, draggable width. */
  drawerWide: boolean;
  /** Whether the garden/terminal split (both panes + the drag handle) is
   *  actually active right now — false whenever only one pane is showing,
   *  narrow-collapsed or not. */
  splitActive: boolean;
}

/** Pure function form — GardenScene.tsx's render-pause check runs inside a
 *  Pixi ticker callback, not a React component body, so it calls this
 *  directly against `useStore.getState()` rather than the hook below. */
export function computeEffectiveLayout(
  viewMode: ViewMode,
  drawerOpen: boolean,
  narrowLayout: boolean
): EffectiveLayout {
  // The split's two panes only fight for space in 'garden' mode with the
  // drawer open at all — this is the one condition the narrow collapse
  // actually changes.
  const narrowCollapsed = viewMode === 'garden' && narrowLayout && drawerOpen;
  return {
    gardenVisible: (viewMode === 'garden' && !narrowCollapsed) || viewMode === 'gardenFull',
    drawerWide: viewMode !== 'garden' || narrowLayout,
    splitActive: viewMode === 'garden' && drawerOpen && !narrowLayout
  };
}

/** React-hook form of `computeEffectiveLayout`, reading its three inputs
 *  straight from the store. */
export function useEffectiveLayout(): EffectiveLayout {
  const viewMode = useStore((s) => s.viewMode);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const narrowLayout = useStore((s) => s.narrowLayout);
  return computeEffectiveLayout(viewMode, drawerOpen, narrowLayout);
}
