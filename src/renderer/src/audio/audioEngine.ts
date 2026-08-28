/**
 * Howler wiring for the two audio buses (Phase 7, mini-player expansion):
 * MUSIC (mini-player rotation across the full multi-generation catalog,
 * battle, evolution ceremony) and SFX (attack sounds, victory chime, cries,
 * evolution riser). `BattleManager`, `EvolutionCeremony`, `GardenScene` and
 * the mini-player UI (`AudioPopover.tsx`) call into this module's exported
 * functions directly — none of them touch Howler or `audioStore` themselves.
 *
 * Music/cry AUDIO BYTES are never bundled — they're fetched-and-cached via
 * main (see `src/main/musicCache.ts` / `cryCache.ts`, mirroring the sprite
 * cache: the renderer's CSP has no connect-src beyond self/blob). Once bytes
 * come back over IPC, they're wrapped in a Blob and played from a `blob:`
 * URL — CSP's media-src/connect-src both allow `blob:` for this reason (see
 * index.html). Bundled SFX (`sfxAssets.ts`) skip all of that; they're
 * same-origin already.
 *
 * The mini-player: `currentMusicMode` tracks which of three things owns the
 * music bus at any moment — the player's own session ('player'), a battle
 * takeover, or an evolution ceremony — with ceremony > battle > player
 * priority (unchanged from the original ambient-only design). The player
 * section below (`playCatalogTrack`/`advancePlayer`/`resumePlayer` and the
 * exported `playerNext`/`playerPrev`/`playerPickTrack`/`playerTogglePause`)
 * replaces the old 5-track ambient rotation with one that draws from the
 * full catalog (`musicCatalog.ts`), respecting the mini-player's generation
 * filter, and remembers whether it's auto-shuffling or holding at a manual
 * pick (`settings.playerMode`) so it can "return to it" after a battle/
 * ceremony takeover the same way the old ambient rotation resumed ambient.
 */
import { Howl, Howler } from 'howler';
import { BATTLE_TRACK_IDS, type MusicTrackId } from '@shared/audioTypes';
import { BROWSABLE_TRACK_IDS, MUSIC_CATALOG_BY_ID } from '@shared/musicCatalog';
import { useAudioStore } from './audioStore';
import { sfxUrl, type SfxKey } from './sfxAssets';
import { sfxKeyForTool, VICTORY_SFX, EVOLUTION_RISER_SFX } from './toolSounds';
import { initMusicPrefetch, stopMusicPrefetch } from './musicPrefetch';

const CROSSFADE_MS = 2500;
const RETRY_MS = 1500;
/** After this many consecutive track failures, stop retrying and surface
 *  "unavailable" instead of spinning through the catalog forever (point 5 of
 *  the mini-player spec: "don't wedge the bus"). */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Cries and the evolution riser sit under the bus's own volume so they never
 *  read as louder than the music/attack-sfx around them. */
const CRY_VOLUME_MUL = 0.6;
const RISER_VOLUME_MUL = 0.8;

type MusicMode = 'none' | 'player' | 'battle' | 'ceremony';

let currentMusic: Howl | null = null;
let currentMusicId: string | null = null;
let currentMusicMode: MusicMode = 'none';

const activeBattles = new Set<string>();
let ceremonyActiveCount = 0;
/** Which ceremony track SHOULD be playing right now (charge or fanfare),
 *  tracked independent of whether music is actually on — so if the user
 *  enables music mid-ceremony, `enableMusic` can resume the right track
 *  instead of `recomputeDesiredMode`'s battle/player-only guard silently
 *  leaving nothing playing (it deliberately no-ops while a ceremony owns the
 *  bus). Cleared once the last active ceremony ends. */
let lastCeremonyTrackId: MusicTrackId | null = null;

// --- mini-player session state ---------------------------------------------
/** The player's own current track id — distinct from `currentMusicId`, which
 *  also reflects battle/ceremony takeovers. Used to resume "the same song"
 *  after a takeover, and as next/prev's anchor. */
let playerCurrentId: string | null = null;
let playerQueue: string[] = [];
let playerLastAutoId: string | null = null;
let playerTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

const trackBlobUrlCache = new Map<string, string | null>();
/** Insertion order of ids with a resolved (non-null) blob URL, oldest first —
 *  bounded below so a full-catalog session doesn't accumulate an unbounded
 *  number of live blob URLs in the renderer (a concurrent memory-crash fix
 *  is in flight elsewhere; this keeps the mini-player clear of that class of
 *  bug). */
const blobUrlInsertOrder: string[] = [];
const BLOB_URL_CACHE_CAP = 20;

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

function trackTitle(id: string): string {
  return MUSIC_CATALOG_BY_ID.get(id)?.title ?? id;
}

/** The pool next/prev, auto-shuffle and prefetch all draw from: the
 *  browsable catalog, scoped to the mini-player's generation filter (falls
 *  back to the full catalog if a filter somehow yields nothing, e.g. a stale
 *  persisted gen id from a regenerated catalog). */
function effectivePool(): string[] {
  const gen = useAudioStore.getState().settings.genFilter;
  if (!gen || gen === 'all') return BROWSABLE_TRACK_IDS as string[];
  const filtered = BROWSABLE_TRACK_IDS.filter((id) => MUSIC_CATALOG_BY_ID.get(id)?.gen === gen);
  return filtered.length > 0 ? filtered : (BROWSABLE_TRACK_IDS as string[]);
}

function sequentialId(pool: string[], currentId: string | null, delta: number): string {
  const n = pool.length;
  const idx = currentId ? pool.indexOf(currentId) : -1;
  return pool[((idx + delta) % n + n) % n];
}

function nextAutoId(pool: string[]): string {
  if (playerQueue.length === 0) {
    playerQueue = shuffle(pool);
    // No-immediate-repeat across a reshuffle boundary too.
    if (playerQueue.length > 1 && playerQueue[0] === playerLastAutoId) {
      [playerQueue[0], playerQueue[1]] = [playerQueue[1], playerQueue[0]];
    }
  }
  const id = playerQueue.shift() as string;
  playerLastAutoId = id;
  return id;
}

/** The next few ids the player would advance to from here, without mutating
 *  any state — used by the background prefetcher to warm what's about to
 *  matter first (see musicPrefetch.ts). Auto mode peeks the existing shuffle
 *  queue (best-effort: it's not topped up just to answer this); manual mode
 *  walks forward sequentially. */
export function peekUpcoming(n: number): string[] {
  const pool = effectivePool();
  if (pool.length === 0) return [];
  const mode = useAudioStore.getState().settings.playerMode;
  if (mode === 'manual') {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(sequentialId(pool, playerCurrentId, i));
    return out;
  }
  return playerQueue.slice(0, n);
}

// --- track fetch/cache (blob URLs) --------------------------------------

function cacheBlobUrl(id: string, url: string | null): void {
  trackBlobUrlCache.set(id, url);
  if (!url) return;
  blobUrlInsertOrder.push(id);
  while (blobUrlInsertOrder.length > BLOB_URL_CACHE_CAP) {
    const idx = blobUrlInsertOrder.findIndex((x) => x !== currentMusicId);
    if (idx === -1) break; // everything left is the currently-playing track
    const [evictId] = blobUrlInsertOrder.splice(idx, 1);
    const evictUrl = trackBlobUrlCache.get(evictId);
    if (evictUrl) URL.revokeObjectURL(evictUrl);
    trackBlobUrlCache.delete(evictId);
  }
}

async function resolveTrackBlobUrl(id: string): Promise<string | null> {
  if (trackBlobUrlCache.has(id)) return trackBlobUrlCache.get(id)!;
  const bytes = await window.api.ensureMusicTrack(id);
  if (!bytes) {
    cacheBlobUrl(id, null);
    return null;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  cacheBlobUrl(id, url);
  return url;
}

// --- crossfade -----------------------------------------------------------

function cancelPlayerTimer(): void {
  if (playerTimer) {
    clearTimeout(playerTimer);
    playerTimer = null;
  }
}

/** Fades the current music Howl (if any) out and a new one in, over
 *  CROSSFADE_MS, to the MUSIC bus's current volume — never a hardcoded 1, so
 *  a user's volume slider is respected through every transition. Returns
 *  false (and touches nothing) if music is off or the track couldn't be
 *  fetched — callers treat that as "skip silently." */
async function crossfadeToTrack(id: string, opts: { loop: boolean }): Promise<boolean> {
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
  if (useAudioStore.getState().settings.musicPaused) {
    next.pause();
  } else {
    next.fade(0, musicGain(), CROSSFADE_MS);
  }

  if (prev) {
    const startVol = typeof prev.volume() === 'number' ? (prev.volume() as number) : musicGain();
    prev.fade(startVol, 0, CROSSFADE_MS);
    setTimeout(() => prev.unload(), CROSSFADE_MS + 150);
  }
  return true;
}

function stopMusic(): void {
  cancelPlayerTimer();
  if (currentMusic) {
    const h = currentMusic;
    const startVol = typeof h.volume() === 'number' ? (h.volume() as number) : 0;
    h.fade(startVol, 0, 400);
    setTimeout(() => h.unload(), 500);
  }
  currentMusic = null;
  currentMusicId = null;
  currentMusicMode = 'none';
  useAudioStore.getState().setNowPlaying({ id: null, title: '', mode: 'none' });
  useAudioStore.getState().setTrackLoading(false);
}

// --- mini-player session ---------------------------------------------------

/** Plays `id` on the MUSIC bus as the player's own track (not a battle/
 *  ceremony takeover): crossfades in, updates the "now playing" label,
 *  persists it as the resume point, and schedules the next auto-advance
 *  near the track's real end. On fetch failure, shows an inline error and
 *  skips forward after a short delay rather than leaving the transport
 *  looking dead. */
async function playCatalogTrack(id: string): Promise<void> {
  cancelPlayerTimer();
  const store = useAudioStore.getState();
  store.setTrackLoading(true);
  store.setTrackError(null);
  const title = trackTitle(id);

  const ok = await crossfadeToTrack(id, { loop: false });
  useAudioStore.getState().setTrackLoading(false);
  if (currentMusicMode !== 'player') {
    // Superseded by a battle/ceremony takeover while this fetch was in
    // flight — that path owns nowPlaying now, but trackLoading is cleared
    // unconditionally above so the label doesn't get stuck on "Loading…".
    return;
  }

  if (!ok) {
    consecutiveFailures++;
    useAudioStore.getState().setTrackError(`Couldn't load "${title}" — skipping`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      useAudioStore.getState().setMusicUnavailable(true);
      useAudioStore.getState().setMusicOn(false);
      return;
    }
    playerTimer = setTimeout(() => void advancePlayer(), RETRY_MS);
    return;
  }
  consecutiveFailures = 0;

  playerCurrentId = id;
  useAudioStore.getState().setNowPlaying({ id, title, mode: 'player' });
  useAudioStore.getState().setLastTrackId(id);

  const thisHowl = currentMusic;
  // `duration()` is 0 until the Howl's metadata has actually loaded — reading
  // it immediately after crossfadeToTrack resolves (right after `play()`, not
  // after decode) would schedule the next crossfade almost instantly instead
  // of near the real track's end.
  thisHowl?.once('load', () => {
    if (currentMusicMode !== 'player' || currentMusic !== thisHowl) return;
    if (useAudioStore.getState().settings.musicPaused) return; // resumed by playerTogglePause instead
    const durationS = thisHowl.duration();
    const untilNextMs = Math.max(1000, durationS * 1000 - CROSSFADE_MS);
    playerTimer = setTimeout(() => void advancePlayer(), untilNextMs);
  });
  thisHowl?.once('loaderror', () => {
    if (currentMusicMode !== 'player' || currentMusic !== thisHowl) return;
    playerTimer = setTimeout(() => void advancePlayer(), RETRY_MS);
  });
}

function advancePlayer(): void {
  if (currentMusicMode !== 'player') return;
  const pool = effectivePool();
  if (pool.length === 0) return;
  const mode = useAudioStore.getState().settings.playerMode;
  const nextId = mode === 'manual' ? sequentialId(pool, playerCurrentId, 1) : nextAutoId(pool);
  void playCatalogTrack(nextId);
}

/** Resumes the player's own session — the same track it was on before a
 *  battle/ceremony takeover (if any), or picks a fresh starting point
 *  otherwise (per `settings.playerMode`). Replaces the old ambient
 *  rotation's `startAmbientRotation`. */
function resumePlayer(): void {
  currentMusicMode = 'player';
  const pool = effectivePool();
  if (pool.length === 0) return;
  const { settings } = useAudioStore.getState();
  let id = playerCurrentId ?? settings.lastTrackId;
  if (!id || !pool.includes(id)) {
    id = settings.playerMode === 'manual' ? pool[0] : nextAutoId(pool);
  }
  void playCatalogTrack(id);
}

function startBattleMusic(): void {
  cancelPlayerTimer();
  currentMusicMode = 'battle';
  const id = BATTLE_TRACK_IDS[Math.floor(Math.random() * BATTLE_TRACK_IDS.length)];
  useAudioStore.getState().setNowPlaying({ id, title: trackTitle(id), mode: 'battle' });
  void crossfadeToTrack(id, { loop: true });
}

/** Ceremony music (started/ended explicitly by EvolutionCeremony's own calls)
 *  takes priority over battle, which takes priority over the player. Called
 *  after every battle-set change and after the last active ceremony ends. */
function recomputeDesiredMode(): void {
  if (ceremonyActiveCount > 0) return; // ceremony owns the bus right now
  const desired: MusicMode = activeBattles.size > 0 ? 'battle' : 'player';
  if (desired === currentMusicMode) return;
  if (desired === 'battle') startBattleMusic();
  else resumePlayer();
}

// --- exported: mini-player transport (called from AudioPopover.tsx) --------

/** Jump straight to `id` (a catalog id — see musicCatalog.ts). Switches the
 *  session into manual mode: after this track ends, cycling continues
 *  forward from here rather than back to shuffling. No-ops while a battle/
 *  ceremony owns the bus (the player resumes here once it gets the bus
 *  back — see `resumePlayer`). */
export function playerPickTrack(id: string): void {
  useAudioStore.getState().setPlayerMode('manual');
  useAudioStore.getState().setMusicPaused(false);
  playerQueue = [];
  playerCurrentId = id;
  if (currentMusicMode !== 'player' && currentMusicMode !== 'none') return;
  currentMusicMode = 'player';
  void playCatalogTrack(id);
}

export function playerNext(): void {
  useAudioStore.getState().setPlayerMode('manual');
  useAudioStore.getState().setMusicPaused(false);
  if (currentMusicMode !== 'player' && currentMusicMode !== 'none') return;
  currentMusicMode = 'player';
  const pool = effectivePool();
  if (pool.length === 0) return;
  void playCatalogTrack(sequentialId(pool, playerCurrentId, 1));
}

export function playerPrev(): void {
  useAudioStore.getState().setPlayerMode('manual');
  useAudioStore.getState().setMusicPaused(false);
  if (currentMusicMode !== 'player' && currentMusicMode !== 'none') return;
  currentMusicMode = 'player';
  const pool = effectivePool();
  if (pool.length === 0) return;
  void playCatalogTrack(sequentialId(pool, playerCurrentId, -1));
}

/** Pauses/resumes whatever's currently on the MUSIC bus (player, battle, or
 *  ceremony music alike) without touching `settings.musicOn` — pausing never
 *  disables music, it just silences the bus until played again. */
export function playerTogglePause(): void {
  const { settings, setMusicPaused } = useAudioStore.getState();
  const nowPaused = !settings.musicPaused;
  setMusicPaused(nowPaused);
  if (!currentMusic) return;
  if (nowPaused) {
    currentMusic.pause();
    cancelPlayerTimer();
  } else {
    currentMusic.play();
    // Covers the "started a track while already paused" case (crossfadeToTrack
    // skips its fade-in then, leaving volume at the Howl's initial 0) as well
    // as the normal case, where this is a same-value no-op.
    currentMusic.volume(musicGain());
    if (currentMusicMode === 'player') {
      const durationS = currentMusic.duration();
      const posS = (currentMusic.seek() as number) || 0;
      const untilNextMs = Math.max(1000, (durationS - posS) * 1000 - CROSSFADE_MS);
      playerTimer = setTimeout(() => void advancePlayer(), untilNextMs);
    }
  }
}

// --- enable/disable music (settings toggle) --------------------------------

async function enableMusic(): Promise<void> {
  const store = useAudioStore.getState();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    store.setMusicUnavailable(true);
    store.setMusicOn(false);
    return;
  }
  store.setMusicUnavailable(false);
  consecutiveFailures = 0;

  if (ceremonyActiveCount > 0 && lastCeremonyTrackId) {
    // recomputeDesiredMode() deliberately no-ops while a ceremony owns the
    // bus (see its doc comment) — that guard exists for battle/player edges,
    // not for "music just got turned on mid-ceremony." Resume whichever
    // ceremony track should currently be playing directly instead of leaving
    // the bus silently off until the next battle/ceremony edge.
    currentMusicMode = 'ceremony';
    const id = lastCeremonyTrackId;
    useAudioStore.getState().setNowPlaying({ id, title: trackTitle(id), mode: 'ceremony' });
    void crossfadeToTrack(id, { loop: id === 'evolutionCharge' });
    return;
  }
  recomputeDesiredMode();
}

function disableMusic(): void {
  stopMusic();
  playerQueue = [];
  playerCurrentId = null;
  stopMusicPrefetch();
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
    if (state.settings.genFilter !== prev.settings.genFilter) {
      // The old shuffle queue may hold ids outside the new filter.
      playerQueue = [];
    }
  });

  initMusicPrefetch();
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
 *  disposal), so player music reliably resumes regardless of how the battle
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
 *  takes priority over battle/player until `notifyEvolutionEnd`. */
export function notifyEvolutionStart(): void {
  ceremonyActiveCount++;
  playSfx(EVOLUTION_RISER_SFX, RISER_VOLUME_MUL);
  cancelPlayerTimer();
  currentMusicMode = 'ceremony';
  lastCeremonyTrackId = 'evolutionCharge';
  useAudioStore
    .getState()
    .setNowPlaying({ id: 'evolutionCharge', title: trackTitle('evolutionCharge'), mode: 'ceremony' });
  void crossfadeToTrack('evolutionCharge', { loop: true });
}

/** The flash/reveal beat: crossfade to the "Congratulations" fanfare (plays
 *  once, short). */
export function notifyEvolutionFlash(): void {
  lastCeremonyTrackId = 'evolutionFanfare';
  useAudioStore
    .getState()
    .setNowPlaying({ id: 'evolutionFanfare', title: trackTitle('evolutionFanfare'), mode: 'ceremony' });
  void crossfadeToTrack('evolutionFanfare', { loop: false });
}

/** Ceremony end: hand the bus back to battle (if the parent was mid-battle)
 *  or the player — never unconditionally the player, so a battle that was
 *  paused for the ceremony resumes its own music instead of a jarring drop
 *  mid-fight. */
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
  currentMusicId: string | null;
  playerCurrentId: string | null;
  activeBattles: string[];
  ceremonyActiveCount: number;
  ctxState: string | undefined;
} {
  return {
    musicMode: currentMusicMode,
    currentMusicId,
    playerCurrentId,
    activeBattles: [...activeBattles],
    ceremonyActiveCount,
    ctxState: Howler.ctx?.state
  };
}

export { Howler };
