import { useStore } from '@/store/store';
import type { ViewMode } from '@/store/store';

/** Phase 8 §1 — four layouts, each with a discoverable chrome toggle AND a
 *  Cmd+1..4 shortcut (bound globally in App.tsx). Order here matches the
 *  shortcut numbers. */
const MODES: { mode: ViewMode; label: string; glyph: string; key: string }[] = [
  { mode: 'garden', label: 'Garden', glyph: '\u{1F332}', key: '1' },
  { mode: 'terminal', label: 'Terminal focus', glyph: '☰', key: '2' },
  { mode: 'gardenFull', label: 'Full-screen garden', glyph: '⛶', key: '3' },
  { mode: 'terminalFull', label: 'Full-screen terminal', glyph: '▣', key: '4' }
];

export function ViewModeSwitcher(): JSX.Element {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);

  return (
    <div className="view-switcher" role="group" aria-label="View mode">
      {MODES.map(({ mode, label, glyph, key }) => (
        <button
          key={mode}
          className={mode === viewMode ? 'view-switcher-btn active' : 'view-switcher-btn'}
          onClick={() => setViewMode(mode)}
          title={`${label} (⌘${key})`}
          aria-label={label}
          aria-pressed={mode === viewMode}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}
