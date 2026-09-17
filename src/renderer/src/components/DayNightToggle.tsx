import { useAppSettingsStore } from '@/store/appSettingsStore';
import type { DayNightMode } from '@shared/appSettingsTypes';
import { SunIcon, MoonIcon } from '@/components/icons';

/** The three segments in display order, each with its own accessible name
 *  and rendered content — auto gets a text label (same recipe
 *  `.party-rail-heading` uses), day/night get the shared pixel icons. */
const SEGMENTS: ReadonlyArray<{ mode: DayNightMode; ariaLabel: string; content: JSX.Element }> = [
  { mode: 'auto', ariaLabel: 'auto day/night', content: <span className="garden-daynight-toggle-label">auto</span> },
  { mode: 'day', ariaLabel: 'force day', content: <SunIcon /> },
  { mode: 'night', ariaLabel: 'force night', content: <MoonIcon /> }
];

/**
 * Garden pane's day/night manual override — top-right DOM overlay above the
 * Pixi canvas (GardenScene.tsx), same "read/write appSettingsStore directly,
 * no second source of truth" shape as ThemeToggle.tsx's quick theme flip.
 * Discrete auto/day/night buttons rather than one cycling button, so no
 * tooltip is needed — a tooltip at this corner clips against the pane edge.
 * Same segmented-group/`aria-pressed` shape as `.view-switcher` (the
 * topbar's view-mode switcher; see index.css), just its own CSS class names
 * below since this group also needs `position: absolute` placement.
 * GardenScene.tsx's own effect still mirrors `settings.dayNightMode` into
 * DayNightOverlay.setModeOverride() live, so a click here updates the
 * overlay immediately.
 */
export function DayNightToggle(): JSX.Element {
  const mode = useAppSettingsStore((s) => s.settings.dayNightMode);
  const setDayNightMode = useAppSettingsStore((s) => s.setDayNightMode);

  return (
    <div className="garden-daynight-toggle" role="group" aria-label="day/night">
      {SEGMENTS.map((segment) => (
        <button
          key={segment.mode}
          type="button"
          className="garden-daynight-toggle-btn"
          aria-pressed={mode === segment.mode}
          aria-label={segment.ariaLabel}
          onClick={() => setDayNightMode(segment.mode)}
        >
          {segment.content}
        </button>
      ))}
    </div>
  );
}
