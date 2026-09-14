import { useAppSettingsStore } from '@/store/appSettingsStore';
import type { DayNightMode } from '@shared/appSettingsTypes';
import { SunIcon, MoonIcon } from '@/components/icons';

/** Cycle order for a click — auto (today's time-based behavior) -> day ->
 *  night -> back to auto. */
const CYCLE: readonly DayNightMode[] = ['auto', 'day', 'night'];

function nextMode(mode: DayNightMode): DayNightMode {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
}

/**
 * Garden pane's day/night manual override — top-right DOM overlay above the
 * Pixi canvas (GardenScene.tsx), same "read/write appSettingsStore directly,
 * no second source of truth" shape as ThemeToggle.tsx's quick theme flip.
 * One button cycles auto -> day -> night; GardenScene.tsx's own effect
 * mirrors `settings.dayNightMode` into DayNightOverlay.setModeOverride()
 * live, so a click here updates the overlay immediately.
 */
export function DayNightToggle(): JSX.Element {
  const mode = useAppSettingsStore((s) => s.settings.dayNightMode);
  const setDayNightMode = useAppSettingsStore((s) => s.setDayNightMode);

  const tip = mode === 'auto' ? 'switch to day' : mode === 'day' ? 'switch to night' : 'switch to auto';

  return (
    <button
      type="button"
      className="garden-daynight-toggle tip"
      data-tip={tip}
      aria-label={tip}
      onClick={() => setDayNightMode(nextMode(mode))}
    >
      {mode === 'day' && <SunIcon />}
      {mode === 'night' && <MoonIcon />}
      {mode === 'auto' && <span className="garden-daynight-toggle-label">auto</span>}
    </button>
  );
}
