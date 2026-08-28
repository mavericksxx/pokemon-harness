import { useEffect, useMemo, useRef, useState } from 'react';
import { useAudioStore } from '@/audio/audioStore';
import { playerNext, playerPickTrack, playerPrev, playerTogglePause } from '@/audio/audioEngine';
import { GEN_LABELS, GEN_ORDER, MUSIC_CATALOG, MUSIC_CATALOG_BY_ID, type MusicGen } from '@shared/musicCatalog';

/** Cap on rendered rows in the mini-player's track list — the full catalog is
 *  1377 tracks; nothing needs all of them as DOM nodes at once, just enough
 *  that "type to narrow" always works before hitting the cap. */
const MAX_LIST_ROWS = 150;

const BROWSABLE = MUSIC_CATALOG.filter((t) => !t.jingle);

/** Speaker icon + popover (Phase 7, mini-player expansion): master mute,
 *  music on/off + volume, SFX on/off + volume, and the mini-player (now
 *  playing, prev/pause/next, a searchable/gen-filterable track list).
 *  Talks only to `audioStore`'s setters and `audioEngine.ts`'s exported
 *  transport functions; never touches Howler directly. */
export function AudioPopover(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const settings = useAudioStore((s) => s.settings);
  const musicUnavailable = useAudioStore((s) => s.musicUnavailable);
  const nowPlaying = useAudioStore((s) => s.nowPlaying);
  const trackLoading = useAudioStore((s) => s.trackLoading);
  const trackError = useAudioStore((s) => s.trackError);
  const warmingGen = useAudioStore((s) => s.warmingGen);
  const warmingProgress = useAudioStore((s) => s.warmingProgress);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const setMusicOn = useAudioStore((s) => s.setMusicOn);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);
  const setSfxOn = useAudioStore((s) => s.setSfxOn);
  const setSfxVolume = useAudioStore((s) => s.setSfxVolume);
  const setGenFilter = useAudioStore((s) => s.setGenFilter);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const genFilter = settings.genFilter;
  const filtered = useMemo(() => {
    const byGen = genFilter === 'all' ? BROWSABLE : BROWSABLE.filter((t) => t.gen === genFilter);
    const q = search.trim().toLowerCase();
    return q ? byGen.filter((t) => t.title.toLowerCase().includes(q)) : byGen;
  }, [genFilter, search]);

  const icon = settings.masterMuted ? '🔇' : settings.musicOn || settings.sfxOn ? '🔊' : '🔈';
  const nowPlayingGenLabel =
    nowPlaying.mode === 'player' && nowPlaying.id
      ? GEN_LABELS[MUSIC_CATALOG_BY_ID.get(nowPlaying.id)?.gen as MusicGen]
      : nowPlaying.mode === 'battle'
        ? 'Battle'
        : nowPlaying.mode === 'ceremony'
          ? 'Evolution'
          : '';

  return (
    <div className="audio-popover-wrap" ref={wrapRef}>
      <button
        className="icon"
        title="Sound settings"
        aria-label="Sound settings"
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open && (
        <div className="audio-popover" data-testid="audio-popover">
          <label className="audio-row audio-row-master">
            <input
              type="checkbox"
              checked={settings.masterMuted}
              onChange={(e) => setMasterMuted(e.target.checked)}
            />
            Mute all
          </label>

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.musicOn} onChange={(e) => setMusicOn(e.target.checked)} />
              Music
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.musicVolume}
              onChange={(e) => setMusicVolume(Number(e.target.value))}
              disabled={!settings.musicOn}
            />
          </div>
          {musicUnavailable && <div className="audio-status">unavailable offline</div>}

          {settings.musicOn && (
            <div className="mini-player" data-testid="mini-player">
              <div className="mini-player-now">
                <div className="mini-player-now-title" title={nowPlaying.title || undefined}>
                  {trackLoading ? 'Loading…' : nowPlaying.title || 'Nothing playing'}
                </div>
                {!trackLoading && nowPlayingGenLabel && (
                  <div className="mini-player-now-gen">{nowPlayingGenLabel}</div>
                )}
              </div>

              <div className="mini-player-transport">
                <button className="icon" title="Previous track" aria-label="Previous track" onClick={playerPrev}>
                  ⏮
                </button>
                <button
                  className="icon"
                  title={settings.musicPaused ? 'Play' : 'Pause'}
                  aria-label={settings.musicPaused ? 'Play' : 'Pause'}
                  onClick={playerTogglePause}
                >
                  {settings.musicPaused ? '▶' : '⏸'}
                </button>
                <button className="icon" title="Next track" aria-label="Next track" onClick={playerNext}>
                  ⏭
                </button>
              </div>

              {trackError && <div className="audio-status audio-error">{trackError}</div>}
              {warmingGen && warmingProgress && (
                <div className="audio-status">
                  warming {GEN_LABELS[warmingGen as MusicGen] ?? warmingGen}… {warmingProgress.done}/
                  {warmingProgress.total}
                </div>
              )}

              <select
                className="mini-player-gen-select"
                value={genFilter}
                onChange={(e) => setGenFilter(e.target.value)}
                aria-label="Generation filter"
              >
                <option value="all">All gens</option>
                {GEN_ORDER.map((g) => (
                  <option key={g} value={g}>
                    {GEN_LABELS[g]}
                  </option>
                ))}
              </select>

              <input
                type="text"
                className="mini-player-search"
                placeholder="Search songs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />

              <div className="mini-player-list">
                {filtered.length === 0 && <div className="mini-player-list-empty">No matches</div>}
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
                  <div className="mini-player-list-empty">
                    +{filtered.length - MAX_LIST_ROWS} more — keep typing to narrow
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.sfxOn} onChange={(e) => setSfxOn(e.target.checked)} />
              SFX
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.sfxVolume}
              onChange={(e) => setSfxVolume(Number(e.target.value))}
              disabled={!settings.sfxOn}
            />
          </div>
        </div>
      )}
    </div>
  );
}
