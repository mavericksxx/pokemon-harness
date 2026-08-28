/**
 * Audio settings + download-state UI store (Phase 7). Deliberately separate
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
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '@shared/audioTypes';

interface AudioUiState {
  settings: AudioSettings;
  /** True while the initial music-track batch is being fetched-and-cached. */
  downloading: boolean;
  downloadProgress: { done: number; total: number };
  /** Set when a music fetch fails while the browser reports itself offline —
   *  cleared the next time the user tries to enable music. */
  musicUnavailable: boolean;
  loaded: boolean;

  setMasterMuted(v: boolean): void;
  setMusicOn(v: boolean): void;
  setMusicVolume(v: number): void;
  setSfxOn(v: boolean): void;
  setSfxVolume(v: number): void;
  setDownloading(v: boolean): void;
  setDownloadProgress(done: number, total: number): void;
  setMusicUnavailable(v: boolean): void;
  hydrate(settings: AudioSettings): void;
}

/** Persists to main (userData JSON, see audioSettings.ts) on every change —
 *  five small scalars, so no debouncing needed. */
function persist(settings: AudioSettings): void {
  void window.api.saveAudioSettings(settings);
}

export const useAudioStore = create<AudioUiState>((set, get) => ({
  settings: DEFAULT_AUDIO_SETTINGS,
  downloading: false,
  downloadProgress: { done: 0, total: 0 },
  musicUnavailable: false,
  loaded: false,

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
  setDownloading: (v) => set({ downloading: v }),
  setDownloadProgress: (done, total) => set({ downloadProgress: { done, total } }),
  setMusicUnavailable: (v) => set({ musicUnavailable: v }),
  hydrate: (settings) => set({ settings, loaded: true })
}));
