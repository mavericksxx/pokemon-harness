import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { useAudioStore } from '@/audio/audioStore';
import { playerNext, playerPickTrack, playerPrev, playerTogglePause } from '@/audio/audioEngine';
import { GEN_LABELS, GEN_ORDER, MUSIC_CATALOG, MUSIC_CATALOG_BY_ID, type MusicGen } from '@shared/musicCatalog';
import { shinyConfig } from '@/scene/garden/shiny';
import { evolutionConfig } from '@/scene/garden/evolution';
import { useTerminalSettingsStore } from '@/terminal/terminalSettingsStore';
import { startClosingTime } from '@/closingTime';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN
} from '@shared/terminalTypes';

/** Cap on rendered rows in the mini-player's track list — see AudioPopover's
 *  old header comment (this replaces it verbatim, Phase 8 §5). */
const MAX_LIST_ROWS = 150;

const BROWSABLE = MUSIC_CATALOG.filter((t) => !t.jingle);

/**
 * Phase 8 §5 — the audio popover's full contents moved here: master mute,
 * music on/off + volume + the mini-player, SFX on/off + volume, plus a
 * read-only Config section (shiny odds / evolve-seconds overrides — both are
 * env-only knobs with no UI to change them, but the accessors were already
 * there so a read-only display is cheap). A compact quick-mute button stays
 * in the chrome (QuickMute.tsx); this is the "full player + volumes" surface
 * it opens into.
 *
 * Slides in from the right, munder-difflin ConfigDrawer-style (DESIGN.md
 * §7.9) — kept mounted always so the CSS transition actually animates;
 * `.settings-panel` without `.open` sits translated off-screen.
 */
export function SettingsPanel(): JSX.Element {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [search, setSearch] = useState('');
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
  const terminalSettings = useTerminalSettingsStore((s) => s.settings);
  const setFontSize = useTerminalSettingsStore((s) => s.setFontSize);
  const setScrollback = useTerminalSettingsStore((s) => s.setScrollback);

  // Esc closes, matching the sessions overview / new-session modals.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

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
        ? 'Battle'
        : nowPlaying.mode === 'ceremony'
          ? 'Evolution'
          : '';

  const shiny = shinyConfig();
  const evo = evolutionConfig();

  return (
    <>
      {open && <div className="settings-backdrop" onClick={() => setOpen(false)} />}
      <aside className={open ? 'settings-panel open' : 'settings-panel'} aria-hidden={!open}>
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon tip" data-tip="Close" aria-label="Close settings" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>Sound</h3>
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
                  {trackLoading ? 'One sec…' : nowPlaying.title || 'Nothing playing'}
                </div>
                {!trackLoading && nowPlayingGenLabel && (
                  <div className="mini-player-now-gen">{nowPlayingGenLabel}</div>
                )}
              </div>

              <div className="mini-player-transport">
                <button className="icon tip" data-tip="Previous track" aria-label="Previous track" onClick={playerPrev}>
                  ⏮
                </button>
                <button
                  className="icon tip"
                  data-tip={settings.musicPaused ? 'Play' : 'Pause'}
                  aria-label={settings.musicPaused ? 'Play' : 'Pause'}
                  onClick={playerTogglePause}
                >
                  {settings.musicPaused ? '▶' : '⏸'}
                </button>
                <button className="icon tip" data-tip="Next track" aria-label="Next track" onClick={playerNext}>
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
        </section>

        <section className="settings-section">
          <h3>Terminal</h3>
          <div className="audio-row">
            <span>Font size</span>
            <input
              type="range"
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={1}
              value={terminalSettings.fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              aria-label="Terminal font size"
            />
            <span className="hint">{terminalSettings.fontSize}px</span>
          </div>
          <div className="audio-row">
            <span>Scrollback</span>
            <input
              type="range"
              min={TERMINAL_SCROLLBACK_MIN}
              max={TERMINAL_SCROLLBACK_MAX}
              step={1000}
              value={terminalSettings.scrollback}
              onChange={(e) => setScrollback(Number(e.target.value))}
              aria-label="Terminal scrollback depth"
            />
            <span className="hint">{terminalSettings.scrollback.toLocaleString()} lines</span>
          </div>
        </section>

        <section className="settings-section">
          <h3>Config</h3>
          <p className="hint settings-config-note">
            Env-only knobs (POKE_SHINY_ODDS / POKE_EVOLVE_SECONDS) — read-only here.
          </p>
          <dl className="settings-config-list">
            <dt>Shiny odds</dt>
            <dd>1 in {shiny.odds}</dd>
            <dt>Evolve to stage 2</dt>
            <dd>{Math.round(evo.stage2Ms / 1000)}s worked</dd>
            <dt>Evolve to stage 3</dt>
            <dd>{Math.round(evo.stage3Ms / 1000)}s worked</dd>
          </dl>
        </section>

        <section className="settings-section">
          <h3>Closing time</h3>
          <p className="hint">
            Every session's Pokémon heads for the garden gate and waves out, then the app quits. Esc cancels.
          </p>
          <button type="button" onClick={() => startClosingTime()}>
            Wrap up &amp; quit <span className="hint">⌘⇧Q</span>
          </button>
        </section>
      </aside>
    </>
  );
}
