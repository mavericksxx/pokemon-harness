import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';
import { TreeIcon } from '@/components/icons';

/** Phase 8 §1 — four layouts, each with a discoverable chrome toggle AND a
 *  Cmd+1..4 shortcut (bound globally in App.tsx). Order here matches the
 *  shortcut numbers. `glyph` is a plain character for the three that already
 *  render as monochrome text symbols (☰ ⛶ ▣ — verified against rendered
 *  screenshots, not emoji-range membership); 'garden' was U+1F332 EVERGREEN
 *  TREE (a genuine color emoji) and renders via TreeIcon (icons.tsx)
 *  instead, as of the ship-cut emoji purge. */
const MODES: { mode: ViewMode; label: string; glyph?: string; key: string }[] = [
  { mode: 'garden', label: 'garden', key: '1' },
  { mode: 'terminal', label: 'terminal focus', glyph: '☰', key: '2' },
  { mode: 'gardenFull', label: 'full-screen garden', glyph: '⛶', key: '3' },
  { mode: 'terminalFull', label: 'full-screen terminal', glyph: '▣', key: '4' }
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
