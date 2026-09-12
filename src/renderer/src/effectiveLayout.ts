import { useStore, type ViewMode } from '@/store/store';
import { ARCEUS_SESSION_ID } from '@shared/arceus';

/** "What should actually be visible right now," combining `viewMode`,
 *  `drawerOpen`, `narrowLayout`, and whether Arceus is the selected session
 *  (store.ts) — the ONE place this combination is computed (issue #2 pt.1).
 *  App.tsx, TerminalDrawer.tsx, and GardenScene.tsx each used to work out
 *  their own slice of this independently; below `NARROW_LAYOUT_MAX_PX`
 *  (gardenSplit.ts) the garden/terminal split stops being structurally
 *  valid, so 'garden' mode now has a fourth effective shape (single-pane,
 *  whichever of the two `drawerOpen` currently prefers) on top of the three
 *  `ViewMode`s themselves — computing that in three places risked them
 *  drifting out of sync.
 *
 *  Arceus is a further wrinkle on top of that: his Hall of Origin HUD
 *  (ArceusHud.tsx) already shows everything the terminal drawer would (a
 *  dispatch box, an exchange log), so in 'garden' mode the drawer must never
 *  show for him regardless of the shared `drawerOpen` preference's value —
 *  see `gardenDrawerOpen` below. This does NOT apply to 'terminal' mode:
 *  that's an explicit, separate user action (the topbar's own toggle) for
 *  raw pty output, not the passive default-open drawer this exists to
 *  suppress, so it keeps working for Arceus like any other session. */
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
  /** Whether the terminal drawer (TerminalDrawer.tsx) should render at all
   *  right now. 'terminal' mode always shows it; 'garden' mode shows it only
   *  when `drawerOpen` is on AND Arceus isn't the one selected. */
  drawerVisible: boolean;
}

/** Pure function form — GardenScene.tsx's render-pause check runs inside a
 *  Pixi ticker callback, not a React component body, so it calls this
 *  directly against `useStore.getState()` rather than the hook below. */
export function computeEffectiveLayout(
  viewMode: ViewMode,
  drawerOpen: boolean,
  narrowLayout: boolean,
  isArceusSelected: boolean
): EffectiveLayout {
  // 'garden' mode's own drawer preference, with Arceus's override folded in
  // — never open for him, no matter what `drawerOpen` itself says. Every
  // other condition below (the split, the narrow-layout collapse) reads
  // THIS instead of the raw `drawerOpen`, so they can't drift out of sync
  // with what TerminalDrawer.tsx actually renders.
  const gardenDrawerOpen = viewMode === 'garden' && drawerOpen && !isArceusSelected;
  // The split's two panes only fight for space in 'garden' mode with the
  // drawer open at all — this is the one condition the narrow collapse
  // actually changes.
  const narrowCollapsed = narrowLayout && gardenDrawerOpen;
  return {
    gardenVisible: (viewMode === 'garden' && !narrowCollapsed) || viewMode === 'gardenFull',
    drawerWide: viewMode !== 'garden' || narrowLayout,
    splitActive: gardenDrawerOpen && !narrowLayout,
    drawerVisible: viewMode === 'terminal' || gardenDrawerOpen
  };
}

/** React-hook form of `computeEffectiveLayout`, reading its four inputs
 *  straight from the store. */
export function useEffectiveLayout(): EffectiveLayout {
  const viewMode = useStore((s) => s.viewMode);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const narrowLayout = useStore((s) => s.narrowLayout);
  const isArceusSelected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  return computeEffectiveLayout(viewMode, drawerOpen, narrowLayout, isArceusSelected);
}
