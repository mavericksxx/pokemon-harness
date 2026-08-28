/**
 * Background catalog-warm for the mini-player's generation filter (Phase 7
 * mini-player expansion). Selecting a generation ("Gen 3") queues that
 * generation's tracks to fetch-and-cache on disk ahead of time, so browsing
 * into a gen and hitting play doesn't stall on a fetch for every single
 * track. This module only ever *asks* main to fetch one track at a time
 * (`window.api.prefetchMusicTrack`) — the actual network I/O, disk streaming
 * and single-flight cancellation all live in `src/main/musicCache.ts`; this
 * is just the renderer-side scheduler deciding *what* and *when*.
 *
 * Memory-safety rules this module exists to satisfy (a full generation is
 * ~200 tracks / ~600-800MB, so this has to be a deliberate trickle, not a
 * blind bulk download):
 *  - Exactly one generation prefetches at a time, globally — no queue of
 *    generations. Rapidly flipping through gen1..gen9 in the filter ends
 *    with only the final selection actually prefetching (`restart()` bumps
 *    `token`, and every await in the trickle loop checks it before
 *    continuing).
 *  - The trigger is debounced ~1.5s so scrubbing through the filter fires
 *    zero fetches for gens the user passes through.
 *  - Bytes are streamed straight to the main-process disk cache
 *    (`prefetchTrack`) — never buffered in the renderer or decoded into an
 *    audio buffer. Only the currently-playing (and crossfading) track is
 *    ever decoded, via the normal interactive `ensureMusicTrack` path in
 *    audioEngine.ts.
 *  - The trickle stops (rather than evicting to make room) once the cache is
 *    within `headroom` bytes of its cap; it doesn't churn the LRU.
 *  - Only runs while music is enabled; disabling music (or quitting) stops
 *    it — see `stopMusicPrefetch`, called from audioEngine.ts's
 *    `disableMusic`.
 */
import { BROWSABLE_TRACK_IDS, MUSIC_CATALOG_BY_ID } from '@shared/musicCatalog';
import { useAudioStore } from './audioStore';
import { peekUpcoming } from './audioEngine';

const DEBOUNCE_MS = 1500;
const BETWEEN_FETCHES_MS = 400;
const QUEUE_AHEAD_COUNT = 5;

let token = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idsForGen(gen: string): string[] {
  if (gen === 'all') return [...BROWSABLE_TRACK_IDS];
  return BROWSABLE_TRACK_IDS.filter((id) => MUSIC_CATALOG_BY_ID.get(id)?.gen === gen);
}

async function runTrickle(myToken: number, gen: string): Promise<void> {
  const upcoming = peekUpcoming(QUEUE_AHEAD_COUNT);
  const rest = idsForGen(gen).filter((id) => !upcoming.includes(id));
  const ids = [...upcoming, ...rest];
  if (ids.length === 0) return;

  useAudioStore.getState().setWarming(gen, { done: 0, total: ids.length });
  let done = 0;
  for (const id of ids) {
    if (myToken !== token) return; // superseded by a newer gen selection

    const status = await window.api.getMusicCacheStatus();
    if (myToken !== token) return;
    if (status.bytes >= status.cap - status.headroom) break; // near cap — stop, don't evict to make room

    const result = await window.api.prefetchMusicTrack(id);
    if (myToken !== token) return;
    // 'busy' means an interactive playback fetch (which always wins) is in
    // flight — skip this id for now rather than retrying in a tight loop; it
    // still gets fetched normally whenever playback actually reaches it.
    done++;
    useAudioStore.getState().setWarming(gen, { done, total: ids.length });
    void result;

    await sleep(BETWEEN_FETCHES_MS);
  }
  if (myToken === token) useAudioStore.getState().setWarming(null, null);
}

function restart(): void {
  token++;
  const myToken = token;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  useAudioStore.getState().setWarming(null, null);
  void window.api.cancelMusicPrefetch();

  if (!useAudioStore.getState().settings.musicOn) return;
  const gen = useAudioStore.getState().settings.genFilter;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runTrickle(myToken, gen);
  }, DEBOUNCE_MS);
}

/** Wires the gen-filter/music-on subscription. Call once from
 *  audioEngine.ts's `initAudio`. */
export function initMusicPrefetch(): void {
  if (subscribed) return;
  subscribed = true;
  useAudioStore.subscribe((state, prev) => {
    if (state.settings.genFilter !== prev.settings.genFilter || state.settings.musicOn !== prev.settings.musicOn) {
      restart();
    }
  });
}

/** Stops any pending/in-flight prefetch immediately — called when music is
 *  turned off. */
export function stopMusicPrefetch(): void {
  token++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  useAudioStore.getState().setWarming(null, null);
  void window.api.cancelMusicPrefetch();
}
