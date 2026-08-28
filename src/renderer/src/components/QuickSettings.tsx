import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useAudioStore } from '@/audio/audioStore';
import { SlidersIcon } from '@/components/icons';

/**
 * Topbar "quick settings" popover — the handful of things worth reaching
 * mid-flow without leaving the garden for the full settings dialog
 * (SettingsPanel.tsx): theme, mute-all + music on/off + volume, the claude
 * provider's auto-mode, and keep-awake. Same anchored-popover shape as
 * AudioPopover.tsx (outside-click via a full-screen catcher, Escape closes)
 * — deliberately NOT a duplicate of AudioPopover's mini-player; the sound
 * row here just links back to it for transport/search/the full track list.
 *
 * Self-contained on purpose (mount point: App.tsx, one line next to the
 * settings gear) — a concurrent topbar restructure is moving the gear and
 * other chrome around; this component owns its own trigger, popover, and
 * CSS block so it can be relocated without touching its internals.
 */
export function QuickSettings(): JSX.Element {
  const [open, setOpen] = useState(false);
  const setFullSettingsOpen = useStore((s) => s.setSettingsOpen);

  const appSettings = useAppSettingsStore((s) => s.settings);
  const setTheme = useAppSettingsStore((s) => s.setTheme);
  const setAutoMode = useAppSettingsStore((s) => s.setAutoMode);
  const setKeepAwake = useAppSettingsStore((s) => s.setKeepAwake);
  const claudeAutoMode = appSettings.autoModeByProvider.claude ?? false;

  const audioSettings = useAudioStore((s) => s.settings);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const setMusicOn = useAudioStore((s) => s.setMusicOn);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const openFullSettings = (): void => {
    setOpen(false);
    setFullSettingsOpen(true);
  };

  return (
    <div className="quick-settings">
      <button
        type="button"
        className="icon tip"
        data-tip="quick settings"
        aria-label="quick settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersIcon />
      </button>

      {open && (
        <>
          <div className="quick-settings-catcher" onClick={() => setOpen(false)} />
          <div className="quick-settings-panel" role="dialog" aria-label="quick settings">
            <div className="segmented" role="group" aria-label="theme">
              {(['system', 'light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={appSettings.theme === mode ? 'segmented-btn active' : 'segmented-btn'}
                  aria-pressed={appSettings.theme === mode}
                  onClick={() => setTheme(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>

            <label className="audio-row audio-row-master">
              <input
                type="checkbox"
                checked={audioSettings.masterMuted}
                onChange={(e) => setMasterMuted(e.target.checked)}
              />
              mute all
            </label>

            <div className="audio-row">
              <label className="audio-toggle">
                <input
                  type="checkbox"
                  checked={audioSettings.musicOn}
                  onChange={(e) => setMusicOn(e.target.checked)}
                />
                music
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={audioSettings.musicVolume}
                onChange={(e) => setMusicVolume(Number(e.target.value))}
                disabled={!audioSettings.musicOn}
              />
            </div>
            <p className="hint quick-settings-hint">transport &amp; track search live in the sound icon</p>

            <label className="settings-row">
              <input
                type="checkbox"
                checked={claudeAutoMode}
                onChange={(e) => setAutoMode('claude', e.target.checked)}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">claude auto mode</span>
                <span className="settings-row-hint">
                  {claudeAutoMode ? 'acts without asking first' : 'pauses for your approval in the terminal'}
                </span>
              </span>
            </label>

            <label className="settings-row">
              <input type="checkbox" checked={appSettings.keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
              <span className="settings-row-text">
                <span className="settings-row-label">keep Mac awake</span>
                <span className="settings-row-hint">
                  {appSettings.keepAwake ? 'your mac stays awake while sessions run' : 'your mac can sleep normally'}
                </span>
              </span>
            </label>

            <button type="button" className="quick-settings-all" onClick={openFullSettings}>
              all settings…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
