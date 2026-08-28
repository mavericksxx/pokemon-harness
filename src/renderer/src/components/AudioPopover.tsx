import { useEffect, useRef, useState } from 'react';
import { useAudioStore } from '@/audio/audioStore';

/** Speaker icon + compact popover (Phase 7): master mute, music on/off +
 *  volume, SFX on/off + volume. Deliberately self-contained — a fuller
 *  settings panel comes in a later phase. Talks only to `audioStore`'s
 *  setters; `audioEngine.ts` reacts to those changes on its own. */
export function AudioPopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const settings = useAudioStore((s) => s.settings);
  const downloading = useAudioStore((s) => s.downloading);
  const downloadProgress = useAudioStore((s) => s.downloadProgress);
  const musicUnavailable = useAudioStore((s) => s.musicUnavailable);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const setMusicOn = useAudioStore((s) => s.setMusicOn);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);
  const setSfxOn = useAudioStore((s) => s.setSfxOn);
  const setSfxVolume = useAudioStore((s) => s.setSfxVolume);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const icon = settings.masterMuted ? '🔇' : settings.musicOn || settings.sfxOn ? '🔊' : '🔈';

  return (
    <div className="audio-popover-wrap" ref={wrapRef}>
      <button
        className="icon"
        title="Sound settings"
        aria-label="Sound settings"
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open && (
        <div className="audio-popover" data-testid="audio-popover">
          <label className="audio-row audio-row-master">
            <input
              type="checkbox"
              checked={settings.masterMuted}
              onChange={(e) => setMasterMuted(e.target.checked)}
            />
            Mute all
          </label>

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.musicOn} onChange={(e) => setMusicOn(e.target.checked)} />
              Music
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
          {downloading && (
            <div className="audio-status">
              downloading music… ({downloadProgress.done}/{downloadProgress.total})
            </div>
          )}
          {musicUnavailable && !downloading && <div className="audio-status">unavailable offline</div>}

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.sfxOn} onChange={(e) => setSfxOn(e.target.checked)} />
              SFX
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.sfxVolume}
              onChange={(e) => setSfxVolume(Number(e.target.value))}
              disabled={!settings.sfxOn}
            />
          </div>
        </div>
      )}
    </div>
  );
}
