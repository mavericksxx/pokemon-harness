import { useAudioStore } from '@/audio/audioStore';
import { SpeakerHighIcon, SpeakerLowIcon, SpeakerMuteIcon } from '@/components/icons';

/**
 * Compact chrome control (Phase 8 §5) — replaces the old AudioPopover
 * dropdown. A single click toggles master mute; the full player, volumes,
 * and track list moved to SettingsPanel (opened via the topbar's gear
 * button). Same icon logic the popover used to show in its trigger — pixel
 * icons (icons.tsx) rather than emoji as of the ship-cut emoji purge.
 */
export function QuickMute(): JSX.Element {
  const settings = useAudioStore((s) => s.settings);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const Icon = settings.masterMuted ? SpeakerMuteIcon : settings.musicOn || settings.sfxOn ? SpeakerHighIcon : SpeakerLowIcon;

  return (
    <button
      className="icon tip"
      data-tip={settings.masterMuted ? 'unmute' : 'mute all'}
      aria-label={settings.masterMuted ? 'unmute' : 'mute all'}
      aria-pressed={settings.masterMuted}
      onClick={() => setMasterMuted(!settings.masterMuted)}
    >
      <Icon />
    </button>
  );
}
