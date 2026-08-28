import { useMemo, useState } from 'react';
import { useAudioStore } from '@/audio/audioStore';
import { playerNext, playerPickTrack, playerPrev, playerTogglePause } from '@/audio/audioEngine';
import { GEN_LABELS, GEN_ORDER, MUSIC_CATALOG, MUSIC_CATALOG_BY_ID, type MusicGen } from '@shared/musicCatalog';

/** Cap on rendered rows in the mini-player's track list. */
const MAX_LIST_ROWS = 150;

const BROWSABLE = MUSIC_CATALOG.filter((t) => !t.jingle);

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
  const settings = useAudioStore((s) => s.settings);
  const nowPlaying = useAudioStore((s) => s.nowPlaying);
  const trackLoading = useAudioStore((s) => s.trackLoading);
  const trackError = useAudioStore((s) => s.trackError);
  const warmingGen = useAudioStore((s) => s.warmingGen);
  const warmingProgress = useAudioStore((s) => s.warmingProgress);
  const setGenFilter = useAudioStore((s) => s.setGenFilter);

  const genFilter = settings.genFilter;
  const filtered = useMemo(() => {
    const byGen = genFilter === 'all' ? BROWSABLE : BROWSABLE.filter((t) => t.gen === genFilter);
    const q = search.trim().toLowerCase();
    return q ? byGen.filter((t) => t.title.toLowerCase().includes(q)) : byGen;
  }, [genFilter, search]);

  const nowPlayingGenLabel =
    nowPlaying.mode === 'player' && nowPlaying.id
      ? GEN_LABELS[MUSIC_CATALOG_BY_ID.get(nowPlaying.id)?.gen as MusicGen]
      : nowPlaying.mode === 'battle'
        ? 'battle'
        : nowPlaying.mode === 'ceremony'
          ? 'evolution'
          : '';

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
          warming {GEN_LABELS[warmingGen as MusicGen] ?? warmingGen}… {warmingProgress.done}/{warmingProgress.total}
        </div>
      )}

      <select
        className="mini-player-gen-select"
        value={genFilter}
        onChange={(e) => setGenFilter(e.target.value)}
        aria-label="generation filter"
      >
        <option value="all">all gens</option>
        {GEN_ORDER.map((g) => (
          <option key={g} value={g}>
            {GEN_LABELS[g]}
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
