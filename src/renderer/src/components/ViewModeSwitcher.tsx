import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { TreeIcon } from '@/components/icons';

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
 *  UI lived). 'terminal' is the one kept — see store.ts's ViewMode comment. */
const MODES: { mode: ViewMode; label: string; glyph?: string; key: string }[] = [
  { mode: 'garden', label: 'garden', key: '1' },
  { mode: 'terminal', label: 'terminal focus', glyph: '☰', key: '2' },
  { mode: 'gardenFull', label: 'full-screen garden', glyph: '⛶', key: '3' }
];

export function ViewModeSwitcher(): JSX.Element {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);

  return (
    <div className="view-switcher" role="group" aria-label="view mode">
      {MODES.map(({ mode, label, glyph, key }) => (
        <button
          key={mode}
          className={mode === viewMode ? 'view-switcher-btn active tip' : 'view-switcher-btn tip'}
          onClick={() => setViewMode(mode)}
          data-tip={`${label} (⌘${key})`}
          aria-label={label}
          aria-pressed={mode === viewMode}
        >
          {glyph ?? <TreeIcon />}
        </button>
      ))}
    </div>
  );
}
