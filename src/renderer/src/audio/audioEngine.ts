/**
 * Howler wiring for the two audio buses (Phase 7): MUSIC (ambient rotation,
 * battle, evolution ceremony) and SFX (attack sounds, victory chime, cries,
 * evolution riser). `BattleManager`, `EvolutionCeremony` and `GardenScene`
 * call into this module's exported functions directly — none of them touch
 * Howler or `audioStore` themselves.
 *
 * Music/cry AUDIO BYTES are never bundled — they're fetched-and-cached via
 * main (see `src/main/musicCache.ts` / `cryCache.ts`, mirroring the sprite
 * cache: the renderer's CSP has no connect-src beyond self/blob). Once bytes
 * come back over IPC, they're wrapped in a Blob and played from a `blob:`
 * URL — CSP's media-src/connect-src both allow `blob:` for this reason (see
 * index.html). Bundled SFX (`sfxAssets.ts`) skip all of that; they're
 * same-origin already.
 */
import { Howl, Howler } from 'howler';
import {
  AMBIENT_TRACK_IDS,
  BATTLE_TRACK_IDS,
  ALL_MUSIC_TRACK_IDS,
  type MusicTrackId
} from '@shared/audioTypes';
import { useAudioStore } from './audioStore';
import { sfxUrl, type SfxKey } from './sfxAssets';
import { sfxKeyForTool, VICTORY_SFX, EVOLUTION_RISER_SFX } from './toolSounds';

const CROSSFADE_MS = 2500;
const AMBIENT_RETRY_MS = 5000;
/** Cries and the evolution riser sit under the bus's own volume so they never
 *  read as louder than the music/attack-sfx around them. */
const CRY_VOLUME_MUL = 0.6;
const RISER_VOLUME_MUL = 0.8;

type MusicMode = 'none' | 'ambient' | 'battle' | 'ceremony';

let currentMusic: Howl | null = null;
let currentMusicId: MusicTrackId | null = null;
let currentMusicMode: MusicMode = 'none';

const activeBattles = new Set<string>();
let ceremonyActiveCount = 0;
/** Which ceremony track SHOULD be playing right now (charge or fanfare),
 *  tracked independent of whether music is actually on — so if the user
 *  enables music mid-ceremony, `enableMusic` can resume the right track
 *  instead of `recomputeDesiredMode`'s battle/ambient-only guard silently
 *  leaving nothing playing (it deliberately no-ops while a ceremony owns the
 *  bus). Cleared once the last active ceremony ends. */
let lastCeremonyTrackId: MusicTrackId | null = null;

let ambientQueue: MusicTrackId[] = [];
let lastAmbientId: MusicTrackId | null = null;
let ambientTimer: ReturnType<typeof setTimeout> | null = null;

const trackBlobUrlCache = new Map<MusicTrackId, string | null>();
const cryHowlCache = new Map<string, Howl | null>();
const sfxHowlCache = new Map<SfxKey, Howl>();

let initialized = false;

// --- bus gain helpers --------------------------------------------------

function musicGain(): number {
  const s = useAudioStore.getState().settings;
  return s.musicOn ? s.musicVolume : 0;
}

function sfxEnabled(): boolean {
  return useAudioStore.getState().settings.sfxOn;
}

function sfxVolume(mul: number): number {
  return useAudioStore.getState().settings.sfxVolume * mul;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- track fetch/cache (blob URLs) --------------------------------------

async function resolveTrackBlobUrl(id: MusicTrackId): Promise<string | null> {
  if (trackBlobUrlCache.has(id)) return trackBlobUrlCache.get(id)!;
  const bytes = await window.api.ensureMusicTrack(id);
  if (!bytes) {
    trackBlobUrlCache.set(id, null);
    return null;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  trackBlobUrlCache.set(id, url);
  return url;
}

// --- crossfade -----------------------------------------------------------

function cancelAmbientTimer(): void {
  if (ambientTimer) {
    clearTimeout(ambientTimer);
    ambientTimer = null;
  }
}

/** Fades the current music Howl (if any) out and a new one in, over
 *  CROSSFADE_MS, to the MUSIC bus's current volume — never a hardcoded 1, so
 *  a user's volume slider is respected through every transition. Returns
 *  false (and touches nothing) if music is off or the track couldn't be
 *  fetched — callers treat that as "skip silently." */
async function crossfadeToTrack(
  id: MusicTrackId,
  opts: { loop: boolean; onEndOnce?: () => void }
): Promise<boolean> {
  if (!useAudioStore.getState().settings.musicOn) return false;
  const url = await resolveTrackBlobUrl(id);
  if (!url) return false;

  const prev = currentMusic;
  // `format` is required here: a `blob:` URL has no file extension, and
  // Howler can't sniff the codec without one — omitting this leaves the Howl
  // stuck at state 'unloaded' forever (silently; no error, no play).
  const next = new Howl({ src: [url], format: ['mp3'], loop: opts.loop, volume: 0 });
  currentMusic = next;
  currentMusicId = id;
  ensureAudioContextResumed(); // musicOn can restore true on launch with no user gesture yet
  next.play();
  next.fade(0, musicGain(), CROSSFADE_MS);
  if (opts.onEndOnce) next.once('end', opts.onEndOnce);

  if (prev) {
    const startVol = typeof prev.volume() === 'number' ? (prev.volume() as number) : musicGain();
    prev.fade(startVol, 0, CROSSFADE_MS);
    setTimeout(() => prev.unload(), CROSSFADE_MS + 150);
  }
  return true;
}

function stopMusic(): void {
  cancelAmbientTimer();
  if (currentMusic) {
    const h = currentMusic;
    const startVol = typeof h.volume() === 'number' ? (h.volume() as number) : 0;
    h.fade(startVol, 0, 400);
    setTimeout(() => h.unload(), 500);
  }
  currentMusic = null;
  currentMusicId = null;
  currentMusicMode = 'none';
}

// --- ambient rotation ------------------------------------------------------

function nextAmbientId(): MusicTrackId {
  if (ambientQueue.length === 0) {
    ambientQueue = shuffle([...AMBIENT_TRACK_IDS]);
    // No-immediate-repeat across a reshuffle boundary too.
    if (ambientQueue.length > 1 && ambientQueue[0] === lastAmbientId) {
      [ambientQueue[0], ambientQueue[1]] = [ambientQueue[1], ambientQueue[0]];
    }
  }
  return ambientQueue.shift() as MusicTrackId;
}

async function playNextAmbient(): Promise<void> {
  if (currentMusicMode !== 'ambient') return; // superseded while we were awaiting
  const id = nextAmbientId();
  lastAmbientId = id;
  const ok = await crossfadeToTrack(id, { loop: false });
  if (currentMusicMode !== 'ambient') return; // superseded mid-fetch
  if (!ok) {
    ambientTimer = setTimeout(() => void playNextAmbient(), AMBIENT_RETRY_MS);
    return;
  }
  // `duration()` is 0 until the Howl's metadata has actually loaded — reading
  // it immediately after crossfadeToTrack resolves (which is right after
  // `play()` is called, not after decode) would schedule the next crossfade
  // almost instantly instead of near the real track's end.
  const thisHowl = currentMusic;
  thisHowl?.once('load', () => {
    if (currentMusicMode !== 'ambient' || currentMusic !== thisHowl) return;
    const durationS = thisHowl.duration();
    const untilNextMs = Math.max(1000, durationS * 1000 - CROSSFADE_MS);
    ambientTimer = setTimeout(() => void playNextAmbient(), untilNextMs);
  });
  thisHowl?.once('loaderror', () => {
    if (currentMusicMode !== 'ambient' || currentMusic !== thisHowl) return;
    ambientTimer = setTimeout(() => void playNextAmbient(), AMBIENT_RETRY_MS);
  });
}

function startAmbientRotation(): void {
  currentMusicMode = 'ambient';
  void playNextAmbient();
}

function startBattleMusic(): void {
  cancelAmbientTimer();
  currentMusicMode = 'battle';
  const id = BATTLE_TRACK_IDS[Math.floor(Math.random() * BATTLE_TRACK_IDS.length)];
  void crossfadeToTrack(id, { loop: true });
}

/** Ceremony music (started/ended explicitly by EvolutionCeremony's own calls)
 *  takes priority over battle, which takes priority over ambient. Called
 *  after every battle-set change and after the last active ceremony ends. */
function recomputeDesiredMode(): void {
  if (ceremonyActiveCount > 0) return; // ceremony owns the bus right now
  const desired: MusicMode = activeBattles.size > 0 ? 'battle' : 'ambient';
  if (desired === currentMusicMode) return;
  if (desired === 'battle') startBattleMusic();
  else startAmbientRotation();
}

// --- enable/disable music (settings toggle) --------------------------------

async function enableMusic(): Promise<void> {
  const store = useAudioStore.getState();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    store.setMusicUnavailable(true);
    store.setMusicOn(false);
    return;
  }
  store.setDownloading(true);
  store.setDownloadProgress(0, ALL_MUSIC_TRACK_IDS.length);
  let anyAmbientReady = false;
  let done = 0;
  for (const id of ALL_MUSIC_TRACK_IDS) {
    const url = await resolveTrackBlobUrl(id);
    done++;
    store.setDownloadProgress(done, ALL_MUSIC_TRACK_IDS.length);
    if (url && (AMBIENT_TRACK_IDS as readonly string[]).includes(id)) anyAmbientReady = true;
  }
  store.setDownloading(false);
  if (!useAudioStore.getState().settings.musicOn) return; // toggled off again mid-download

  if (!anyAmbientReady) {
    store.setMusicUnavailable(true);
    store.setMusicOn(false);
    return;
  }
  store.setMusicUnavailable(false);
  currentMusicMode = 'none'; // force the mode switch below to actually (re)start
  if (ceremonyActiveCount > 0 && lastCeremonyTrackId) {
    // recomputeDesiredMode() deliberately no-ops while a ceremony owns the
    // bus (see its doc comment) — that guard exists for battle/ambient
    // edges, not for "music just got turned on mid-ceremony." Resume
    // whichever ceremony track should currently be playing directly instead
    // of leaving the bus silently on 'none' until the next battle/ceremony
    // edge.
    currentMusicMode = 'ceremony';
    void crossfadeToTrack(lastCeremonyTrackId, { loop: lastCeremonyTrackId === 'evolutionCharge' });
  } else {
    recomputeDesiredMode();
  }
}

function disableMusic(): void {
  stopMusic();
}

// --- public: init ------------------------------------------------------

/** Call once, at app start (App.tsx) — independent of the garden scene's own
 *  lifecycle, so the popover works even before/without it mounting. */
export async function initAudio(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const settings = await window.api.getAudioSettings();
  useAudioStore.getState().hydrate(settings);
  Howler.mute(settings.masterMuted);

  useAudioStore.subscribe((state, prev) => {
    if (state.settings.masterMuted !== prev.settings.masterMuted) Howler.mute(state.settings.masterMuted);
    if (state.settings.musicVolume !== prev.settings.musicVolume) currentMusic?.volume(musicGain());
    if (state.settings.musicOn !== prev.settings.musicOn) {
      if (state.settings.musicOn) void enableMusic();
      else disableMusic();
    }
  });

  if (settings.musicOn) void enableMusic();
}

// --- public: battles (called from BattleManager) ------------------------

/** One parent's battle began. Multiple overlapping battles share one battle
 *  track — only the empty->non-empty edge triggers the crossfade. */
export function notifyBattleStart(parentId: string): void {
  if (activeBattles.has(parentId)) return;
  const wasEmpty = activeBattles.size === 0;
  activeBattles.add(parentId);
  if (wasEmpty) recomputeDesiredMode();
}

/** One parent's battle ended — called from every teardown path (the normal
 *  victory path, a forced session-kill mid-battle, and BattleManager
 *  disposal), so ambient music reliably resumes regardless of how the battle
 *  ended, not just the happy path. */
export function notifyBattleEnd(parentId: string): void {
  if (!activeBattles.delete(parentId)) return;
  if (activeBattles.size === 0) recomputeDesiredMode();
}

export function playAttackSound(tool: string): void {
  playSfx(sfxKeyForTool(tool));
}

export function playVictoryChime(): void {
  playSfx(VICTORY_SFX);
}

// --- public: evolution ceremony (called from EvolutionCeremony) ---------

/** Ceremony start: crossfade to the "Evolution" charge loop (if music is on)
 *  and play the soft riser SFX (regardless of music setting). Ceremony music
 *  takes priority over battle/ambient until `notifyEvolutionEnd`. */
export function notifyEvolutionStart(): void {
  ceremonyActiveCount++;
  playSfx(EVOLUTION_RISER_SFX, RISER_VOLUME_MUL);
  cancelAmbientTimer();
  currentMusicMode = 'ceremony';
  lastCeremonyTrackId = 'evolutionCharge';
  void crossfadeToTrack('evolutionCharge', { loop: true });
}

/** The flash/reveal beat: crossfade to the "Congratulations" fanfare (plays
 *  once, short). */
export function notifyEvolutionFlash(): void {
  lastCeremonyTrackId = 'evolutionFanfare';
  void crossfadeToTrack('evolutionFanfare', { loop: false });
}

/** Ceremony end: hand the bus back to battle (if the parent was mid-battle)
 *  or ambient — never unconditionally ambient, so a battle that was paused
 *  for the ceremony resumes its own music instead of a jarring drop to
 *  ambient mid-fight. */
export function notifyEvolutionEnd(): void {
  ceremonyActiveCount = Math.max(0, ceremonyActiveCount - 1);
  if (ceremonyActiveCount > 0) return;
  lastCeremonyTrackId = null;
  currentMusicMode = 'none';
  recomputeDesiredMode();
}

/** Cry of the evolved species, at the reveal — see notifyEvolutionFlash for
 *  the music side of the same beat. */
export function playEvolutionCry(speciesId: string): void {
  void playCry(speciesId);
}

// --- public: sessions (called from GardenScene) --------------------------

/** Cry on a session's walker's first spawn. */
export function playSpawnCry(speciesId: string): void {
  void playCry(speciesId);
}

/** Shiny-spawn sound hook — deliberately a no-op. A concurrent phase owns
 *  shiny sprites; this phase does not wire shiny-specific audio. Callers can
 *  wire this up later without any other change here. */
export function onShinySpawn(): void {
  // Intentionally empty — see doc comment above.
}

// --- sfx / cry playback ----------------------------------------------------

/** Defensive belt-and-suspenders alongside the main-process autoplay-policy
 *  switch (see index.ts): if the AudioContext is ever suspended when a sound
 *  tries to play (a stricter Electron build, a future Chromium change), kick
 *  it awake instead of silently dropping the sound. */
function ensureAudioContextResumed(): void {
  if (Howler.ctx && Howler.ctx.state === 'suspended') void Howler.ctx.resume();
}

function getSfxHowl(key: SfxKey): Howl | null {
  const cached = sfxHowlCache.get(key);
  if (cached) return cached;
  const url = sfxUrl(key);
  if (!url) return null;
  const h = new Howl({ src: [url] });
  sfxHowlCache.set(key, h);
  return h;
}

function playSfx(key: SfxKey, mul = 1): void {
  if (!sfxEnabled()) return;
  const h = getSfxHowl(key);
  if (!h) return;
  ensureAudioContextResumed();
  h.volume(sfxVolume(mul));
  h.play();
}

async function playCry(speciesId: string): Promise<void> {
  if (!sfxEnabled()) return;
  let h = cryHowlCache.get(speciesId);
  if (h === undefined) {
    const bytes = await window.api.ensureCry(speciesId);
    if (!bytes) {
      cryHowlCache.set(speciesId, null);
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    // See crossfadeToTrack's comment — a blob: URL needs an explicit format.
    h = new Howl({ src: [url], format: ['mp3'] });
    cryHowlCache.set(speciesId, h);
  }
  if (!h || !sfxEnabled()) return;
  ensureAudioContextResumed();
  h.volume(sfxVolume(CRY_VOLUME_MUL));
  h.play();
}

// --- dev-only introspection ------------------------------------------------
// Mirrors the app's existing `__pokeDebug` precedent (main.tsx) — a CDP pass
// can't reach module-local state otherwise, and there's no audio hardware in
// CI to listen to.
export function debugSnapshot(): {
  musicMode: MusicMode;
  currentMusicId: MusicTrackId | null;
  activeBattles: string[];
  ceremonyActiveCount: number;
  ctxState: string | undefined;
} {
  return {
    musicMode: currentMusicMode,
    currentMusicId,
    activeBattles: [...activeBattles],
    ceremonyActiveCount,
    ctxState: Howler.ctx?.state
  };
}

export { Howler };
