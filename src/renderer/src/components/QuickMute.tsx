import { useAudioStore } from '@/audio/audioStore';

/**
 * Compact chrome control (Phase 8 §5) — replaces the old AudioPopover
 * dropdown. A single click toggles master mute; the full player, volumes,
 * and track list moved to SettingsPanel (opened via the topbar's gear
 * button). Same icon logic the popover used to show in its trigger.
 */
export function QuickMute(): JSX.Element {
  const settings = useAudioStore((s) => s.settings);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const icon = settings.masterMuted ? '🔇' : settings.musicOn || settings.sfxOn ? '🔊' : '🔈';

  return (
    <button
      className="icon"
      title={settings.masterMuted ? 'Unmute' : 'Mute all'}
      aria-label={settings.masterMuted ? 'Unmute' : 'Mute all'}
      aria-pressed={settings.masterMuted}
      onClick={() => setMasterMuted(!settings.masterMuted)}
    >
      {icon}
    </button>
  );
}
