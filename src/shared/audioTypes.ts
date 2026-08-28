/** Types shared between main, preload and renderer for the audio system
 *  (Phase 7). Dependency-free, matching the rest of shared/. */

/** The app's original curated HGSS OST ids (battle/evolution ceremony music
 *  — see `src/main/musicCache.ts`). Kept as a narrow literal type (rather
 *  than the mini-player's much larger catalog, which is just `string` —
 *  `src/shared/musicCatalog.ts`) because these specific ids are named
 *  directly by `audioEngine.ts`'s battle/ceremony logic. Stable regardless of
 *  the scraped track title/filename, so renaming upstream never breaks the
 *  cache. */
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

export const BATTLE_TRACK_IDS: readonly MusicTrackId[] = ['battleWild', 'battleTrainer'];
export const CEREMONY_TRACK_IDS: readonly MusicTrackId[] = ['evolutionCharge', 'evolutionFanfare'];

/** Whether the mini-player's auto-cycle is picking the next track itself, or
 *  holding at a manual pick (next/prev also switch into 'manual' — see
 *  `audioEngine.ts`'s player section). */
export type PlayerMode = 'auto' | 'manual';

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

  /** Mini-player (catalog id from `musicCatalog.ts`, or one of the 9 curated
   *  `MusicTrackId`s — the same id space) last played, and whether auto-cycle
   *  or a manual pick governs advancing to the next one. Persisted so
   *  relaunch resumes sensibly. */
  lastTrackId: string | null;
  playerMode: PlayerMode;
  /** Mini-player's generation filter (a `MusicGen` from `musicCatalog.ts`, or
   *  'all') — kept as a plain string here so this file stays dependency-free
   *  (see header); the mini-player validates it against `GEN_ORDER`. */
  genFilter: string;
  /** True if the user paused the mini-player — independent of `musicOn`
   *  (pausing never disables music in settings, it just silences the bus). */
  musicPaused: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  masterMuted: false,
  musicOn: false,
  musicVolume: 0.5,
  sfxOn: true,
  sfxVolume: 0.7,
  lastTrackId: null,
  playerMode: 'auto',
  genFilter: 'all',
  musicPaused: false
};
