/** Types shared between main, preload and renderer for the audio system
 *  (Phase 7). Dependency-free, matching the rest of shared/. */

/** HGSS OST tracks fetched at runtime from khinsider (never bundled — see
 *  `src/main/musicCache.ts`). Stable ids, independent of the scraped track
 *  title/filename, so renaming upstream never breaks the cache. */
export type MusicTrackId =
  | 'route29'
  | 'newBarkTown'
  | 'cherrygroveCity'
  | 'violetCity'
  | 'azaleaTown'
  | 'battleWild'
  | 'battleTrainer'
  | 'evolutionCharge'
  | 'evolutionFanfare';

export const AMBIENT_TRACK_IDS: readonly MusicTrackId[] = [
  'route29',
  'newBarkTown',
  'cherrygroveCity',
  'violetCity',
  'azaleaTown'
];
export const BATTLE_TRACK_IDS: readonly MusicTrackId[] = ['battleWild', 'battleTrainer'];
export const CEREMONY_TRACK_IDS: readonly MusicTrackId[] = ['evolutionCharge', 'evolutionFanfare'];
export const ALL_MUSIC_TRACK_IDS: readonly MusicTrackId[] = [
  ...AMBIENT_TRACK_IDS,
  ...BATTLE_TRACK_IDS,
  ...CEREMONY_TRACK_IDS
];

/** The two independent volume/mute buses, plus one master mute overriding
 *  both. All five persisted (Phase 7 spec) to a userData JSON file, like the
 *  sprite cache's disk artifacts — see `src/main/audioSettings.ts`. */
export interface AudioSettings {
  masterMuted: boolean;
  /** Music defaults OFF on first run (don't startle). */
  musicOn: boolean;
  musicVolume: number;
  /** SFX defaults ON on first run. */
  sfxOn: boolean;
  sfxVolume: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  masterMuted: false,
  musicOn: false,
  musicVolume: 0.5,
  sfxOn: true,
  sfxVolume: 0.7
};
