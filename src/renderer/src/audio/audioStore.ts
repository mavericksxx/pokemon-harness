/**
 * Audio settings + mini-player UI store (Phase 7). Deliberately separate
 * from `@/store/store.ts` (the session/garden store) — nothing here overlaps
 * with session state, and keeping it apart avoids any merge surface with
 * concurrent work on that file.
 *
 * This store holds UI-facing state only. The actual Howler wiring (buses,
 * crossfades, playback) lives in `audioEngine.ts`, which subscribes to this
 * store's settings and reacts to changes — the popover component only ever
 * calls the setters below, never touches Howler directly.
 */
import { create } from 'zustand';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings, type PlayerMode } from '@shared/audioTypes';

/** What's actually audible right now, for the mini-player's always-visible
 *  "now playing" label — distinct from `settings.lastTrackId` because a
 *  battle/ceremony takeover plays a different track than the player's own
 *  session without touching that persisted pointer (see audioEngine.ts). */
export interface NowPlaying {
  id: string | null;
  title: string;
  mode: 'player' | 'battle' | 'ceremony' | 'none';
}

interface AudioUiState {
  settings: AudioSettings;
  /** Set when a music fetch fails while the browser reports itself offline,
   *  or after too many consecutive track failures — cleared the next time
   *  the user tries to enable music. */
  musicUnavailable: boolean;
  loaded: boolean;

  nowPlaying: NowPlaying;
  /** True while the mini-player is waiting on a first-time track fetch
   *  (manual pick, next/prev, or auto-advance) — lets the popover show a
   *  loading state instead of dead buttons. */
  trackLoading: boolean;
  /** Inline "couldn't load X — skipping" message, self-clearing on the next
   *  successful track change. */
  trackError: string | null;
  /** Non-null while the generation filter's background catalog-warm is
   *  running (see musicPrefetch.ts) — null when idle/stopped/finished. */
  warmingGen: string | null;
  warmingProgress: { done: number; total: number } | null;

  setMasterMuted(v: boolean): void;
  setMusicOn(v: boolean): void;
  setMusicVolume(v: number): void;
  setSfxOn(v: boolean): void;
  setSfxVolume(v: number): void;
  setMusicUnavailable(v: boolean): void;
  hydrate(settings: AudioSettings): void;

  setLastTrackId(v: string | null): void;
  setPlayerMode(v: PlayerMode): void;
  setGenFilter(v: string): void;
  setMusicPaused(v: boolean): void;

  setNowPlaying(v: NowPlaying): void;
  setTrackLoading(v: boolean): void;
  setTrackError(v: string | null): void;
  setWarming(gen: string | null, progress: { done: number; total: number } | null): void;
}

/** Persists to main (userData JSON, see audioSettings.ts) on every change —
 *  five small scalars, so no debouncing needed. */
function persist(settings: AudioSettings): void {
  void window.api.saveAudioSettings(settings);
}

export const useAudioStore = create<AudioUiState>((set, get) => ({
  settings: DEFAULT_AUDIO_SETTINGS,
  musicUnavailable: false,
  loaded: false,
  nowPlaying: { id: null, title: '', mode: 'none' },
  trackLoading: false,
  trackError: null,
  warmingGen: null,
  warmingProgress: null,

  setMasterMuted: (v) => {
    const settings = { ...get().settings, masterMuted: v };
    set({ settings });
    persist(settings);
  },
  setMusicOn: (v) => {
    const settings = { ...get().settings, musicOn: v };
    set({ settings, musicUnavailable: false });
    persist(settings);
  },
  setMusicVolume: (v) => {
    const settings = { ...get().settings, musicVolume: v };
    set({ settings });
    persist(settings);
  },
  setSfxOn: (v) => {
    const settings = { ...get().settings, sfxOn: v };
    set({ settings });
    persist(settings);
  },
  setSfxVolume: (v) => {
    const settings = { ...get().settings, sfxVolume: v };
    set({ settings });
    persist(settings);
  },
  setMusicUnavailable: (v) => set({ musicUnavailable: v }),
  hydrate: (settings) => set({ settings, loaded: true }),

  setLastTrackId: (v) => {
    const settings = { ...get().settings, lastTrackId: v };
    set({ settings });
    persist(settings);
  },
  setPlayerMode: (v) => {
    const settings = { ...get().settings, playerMode: v };
    set({ settings });
    persist(settings);
  },
  setGenFilter: (v) => {
    const settings = { ...get().settings, genFilter: v };
    set({ settings });
    persist(settings);
  },
  setMusicPaused: (v) => {
    const settings = { ...get().settings, musicPaused: v };
    set({ settings });
    persist(settings);
  },

  setNowPlaying: (v) => set({ nowPlaying: v }),
  setTrackLoading: (v) => set({ trackLoading: v }),
  setTrackError: (v) => set({ trackError: v }),
  setWarming: (gen, progress) => set({ warmingGen: gen, warmingProgress: progress })
}));
