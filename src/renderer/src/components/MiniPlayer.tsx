import { useEffect, useMemo, useState } from 'react';
import { useAudioStore } from '@/audio/audioStore';
import {
  loadMusicCatalog,
  playerNext,
  playerPickTrack,
  playerPrev,
  playerTogglePause,
  type MusicCatalogModule
} from '@/audio/audioEngine';
import type { MusicGen } from '@shared/musicCatalog';

/** Cap on rendered rows in the mini-player's track list. */
const MAX_LIST_ROWS = 150;

/**
 * The mini-player itself — now-playing label, transport, gen filter, search,
 * and the searchable track list. Extracted out of SettingsPanel so the
 * topbar sound icon's popover (AudioPopover.tsx) can show the same player
 * without duplicating it; SettingsPanel's own "sound" section still renders
 * this unchanged.
 *
 * The track list is always the FULL browsable catalog, battle tracks
 * included — a manual search/click here always wins over the ambient
 * shuffle's battle-track filter (see `audioEngine.ts`'s `effectivePool`).
 */
export function MiniPlayer(): JSX.Element {
  const [search, setSearch] = useState('');
  // The 324 KB track-index JSON only loads once the mini-player actually
  // mounts (it's only ever rendered while `settings.musicOn`, so this is
  // effectively the "music/mini-player in use" trigger the catalog split is
  // gated on — see audioEngine.ts's `loadMusicCatalog`).
  const [catalog, setCatalog] = useState<MusicCatalogModule | null>(null);
  const settings = useAudioStore((s) => s.settings);
  const nowPlaying = useAudioStore((s) => s.nowPlaying);
  const trackLoading = useAudioStore((s) => s.trackLoading);
  const trackError = useAudioStore((s) => s.trackError);
  const warmingGen = useAudioStore((s) => s.warmingGen);
  const warmingProgress = useAudioStore((s) => s.warmingProgress);
  const setGenFilter = useAudioStore((s) => s.setGenFilter);

  useEffect(() => {
    let alive = true;
    void loadMusicCatalog().then((m) => {
      if (alive) setCatalog(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const genFilter = settings.genFilter;
  const browsable = useMemo(() => catalog?.MUSIC_CATALOG.filter((t) => !t.jingle) ?? [], [catalog]);
  const filtered = useMemo(() => {
    const byGen = genFilter === 'all' ? browsable : browsable.filter((t) => t.gen === genFilter);
    const q = search.trim().toLowerCase();
    return q ? byGen.filter((t) => t.title.toLowerCase().includes(q)) : byGen;
  }, [browsable, genFilter, search]);

  const nowPlayingGenLabel =
    !catalog
      ? ''
      : nowPlaying.mode === 'player' && nowPlaying.id
        ? catalog.GEN_LABELS[catalog.MUSIC_CATALOG_BY_ID.get(nowPlaying.id)?.gen as MusicGen]
        : nowPlaying.mode === 'battle'
          ? 'battle'
          : nowPlaying.mode === 'ceremony'
            ? 'evolution'
            : '';

  if (!catalog) {
    return (
      <div className="mini-player" data-testid="mini-player">
        <div className="audio-status">loading music catalog…</div>
      </div>
    );
  }

  return (
    <div className="mini-player" data-testid="mini-player">
      <div className="mini-player-now">
        <div className="mini-player-now-title" title={nowPlaying.title || undefined}>
          {trackLoading ? 'one sec…' : nowPlaying.title || 'nothing playing'}
        </div>
        {!trackLoading && nowPlayingGenLabel && <div className="mini-player-now-gen">{nowPlayingGenLabel}</div>}
      </div>

      <div className="mini-player-transport">
        <button className="icon tip" data-tip="previous track" aria-label="previous track" onClick={playerPrev}>
          ⏮
        </button>
        <button
          className="icon tip"
          data-tip={settings.musicPaused ? 'play' : 'pause'}
          aria-label={settings.musicPaused ? 'play' : 'pause'}
          onClick={playerTogglePause}
        >
          {settings.musicPaused ? '▶' : '⏸'}
        </button>
        <button className="icon tip" data-tip="next track" aria-label="next track" onClick={playerNext}>
          ⏭
        </button>
      </div>

      {trackError && <div className="audio-status audio-error">{trackError}</div>}
      {warmingGen && warmingProgress && (
        <div className="audio-status">
          warming {catalog.GEN_LABELS[warmingGen as MusicGen] ?? warmingGen}… {warmingProgress.done}/
          {warmingProgress.total}
        </div>
      )}

      <select
        className="mini-player-gen-select"
        value={genFilter}
        onChange={(e) => setGenFilter(e.target.value)}
        aria-label="generation filter"
      >
        <option value="all">all gens</option>
        {catalog.GEN_ORDER.map((g) => (
          <option key={g} value={g}>
            {catalog.GEN_LABELS[g]}
          </option>
        ))}
      </select>

      <input
        type="text"
        className="mini-player-search"
        placeholder="search songs…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="mini-player-list">
        {filtered.length === 0 && <div className="mini-player-list-empty">no matches</div>}
        {filtered.slice(0, MAX_LIST_ROWS).map((t) => (
          <div
            key={t.id}
            className={'mini-player-list-item' + (t.id === nowPlaying.id ? ' active' : '')}
            title={t.title}
            onClick={() => playerPickTrack(t.id)}
          >
            {t.title}
          </div>
        ))}
        {filtered.length > MAX_LIST_ROWS && (
          <div className="mini-player-list-empty">+{filtered.length - MAX_LIST_ROWS} more — keep typing to narrow</div>
        )}
      </div>
    </div>
  );
}
