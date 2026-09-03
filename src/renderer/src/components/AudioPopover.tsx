import { useEffect, useRef, useState } from 'react';
import { useAudioStore } from '@/audio/audioStore';
import { SpeakerHighIcon, SpeakerLowIcon, SpeakerMuteIcon } from '@/components/icons';
import { MiniPlayer } from '@/components/MiniPlayer';

/**
 * Topbar sound icon (formerly QuickMute.tsx's plain mute-toggle button) —
 * clicking it now opens a small anchored popover holding the mini-player
 * (`MiniPlayer.tsx`, shared with SettingsPanel's own "sound" section) plus
 * the master mute toggle and music volume, rather than toggling mute
 * directly. The icon itself still communicates mute state at a glance (same
 * icon-swap logic the old QuickMute used) even with the popover closed.
 * Closes on outside click or Escape, same pattern as WorkspaceSwitcher's
 * dropdown.
 */
export function AudioPopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const settings = useAudioStore((s) => s.settings);
  const musicUnavailable = useAudioStore((s) => s.musicUnavailable);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const setMusicOn = useAudioStore((s) => s.setMusicOn);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);

  const Icon = settings.masterMuted
    ? SpeakerMuteIcon
    : settings.musicOn || settings.sfxOn
      ? SpeakerHighIcon
      : SpeakerLowIcon;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Outside-click dismissal follows the document-level pointerdown +
  // wrapper-ref `.contains()` pattern already established by
  // OverflowChipRow.tsx, instead of using a full-screen catcher div.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="audio-popover" ref={wrapperRef}>
      <button
        type="button"
        className="topbar-icon-btn tip"
        data-tip={settings.masterMuted ? 'muted — open player' : 'music player'}
        aria-label="music player"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon />
      </button>

      {open && (
        <div className="audio-popover-panel" role="dialog" aria-label="music player">
          <label className="audio-row audio-row-master">
            <input
              type="checkbox"
              checked={settings.masterMuted}
              onChange={(e) => setMasterMuted(e.target.checked)}
            />
            mute all
          </label>

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.musicOn} onChange={(e) => setMusicOn(e.target.checked)} />
              music
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.musicVolume}
              onChange={(e) => setMusicVolume(Number(e.target.value))}
              disabled={!settings.musicOn}
            />
          </div>
          {musicUnavailable && <div className="audio-status">unavailable offline</div>}

          {settings.musicOn && <MiniPlayer />}
        </div>
      )}
    </div>
  );
}
