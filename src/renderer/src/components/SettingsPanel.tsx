import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { useAudioStore } from '@/audio/audioStore';
import { MiniPlayer } from '@/components/MiniPlayer';
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
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { ResetArceusDialog } from '@/components/ResetArceusDialog';
import { PROVIDER_LIST } from '@shared/agentProvider';
import { showUpdateToast } from '@/updateNotifier';

/** Providers whose auto-permission-mode is actually wireable (parity sweep
 *  item 1) — the ones with a verified `autoModeArgs` in agentProvider.ts. */
const AUTO_MODE_PROVIDERS = PROVIDER_LIST.filter((p) => p.autoModeArgs);

/**
 * Phase 8 §5 — the audio popover's full contents moved here: master mute,
 * music on/off + volume + the mini-player (`MiniPlayer.tsx`, shared with the
 * topbar's own sound-icon popover — `AudioPopover.tsx`), SFX on/off +
 * volume, plus a read-only Config section (shiny odds / evolve-seconds
 * overrides — both are env-only knobs with no UI to change them, but the
 * accessors were already there so a read-only display is cheap).
 *

 * Slides in from the right, munder-difflin ConfigDrawer-style (DESIGN.md
 * §7.9) — kept mounted always so the CSS transition actually animates;
 * `.settings-panel` without `.open` sits translated off-screen.
 */
export function SettingsPanel(): JSX.Element {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [resetArceusOpen, setResetArceusOpen] = useState(false);
  const settings = useAudioStore((s) => s.settings);
  const musicUnavailable = useAudioStore((s) => s.musicUnavailable);
  const setMasterMuted = useAudioStore((s) => s.setMasterMuted);
  const setMusicOn = useAudioStore((s) => s.setMusicOn);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);
  const setSfxOn = useAudioStore((s) => s.setSfxOn);
  const setSfxVolume = useAudioStore((s) => s.setSfxVolume);
  const terminalSettings = useTerminalSettingsStore((s) => s.settings);
  const setFontSize = useTerminalSettingsStore((s) => s.setFontSize);
  const setScrollback = useTerminalSettingsStore((s) => s.setScrollback);
  const appSettings = useAppSettingsStore((s) => s.settings);
  const setTheme = useAppSettingsStore((s) => s.setTheme);
  const setAutoMode = useAppSettingsStore((s) => s.setAutoMode);
  const setKeepAwake = useAppSettingsStore((s) => s.setKeepAwake);
  const harnessHomePath = useAppSettingsStore((s) => s.harnessHomePath);
  const setHarnessHomeDir = useAppSettingsStore((s) => s.setHarnessHomeDir);
  // Live count for the keep-awake row's "N sessions live" — a session whose
  // PTY has exited is flipped to 'done' the moment it happens (see
  // main/index.ts's own comment on the same signal), so this is the
  // renderer-side equivalent of main's ptyManager-backed count without a new
  // IPC round trip just for a label.
  const liveSessionCount = useStore((s) => s.sessions.filter((sess) => sess.status !== 'done').length);

  // Tier-1 update check (ship-cut item 4) — "check now" row. `appVersion`
  // fetched once on open rather than kept live: it can't change during a
  // running process. `checkStatus` is purely this row's own local feedback
  // (idle/checking/result text) — a found update ALSO fires the shared
  // toast (showUpdateToast, same one main's background check triggers), so
  // clicking "check now" and finding something newer looks identical to the
  // passive 24h check finding it, just on demand.
  const [appVersion, setAppVersion] = useState('');
  const [checkStatus, setCheckStatus] = useState<'idle' | 'checking' | 'up to date' | 'checked — offline?'>('idle');
  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion);
  }, []);
  const checkForUpdateNow = async (): Promise<void> => {
    setCheckStatus('checking');
    const result = await window.api.checkForUpdateNow();
    if (result?.available) {
      showUpdateToast(result);
      setCheckStatus('idle');
    } else {
      setCheckStatus(result ? 'up to date' : 'checked — offline?');
    }
  };

  // Harness home directory (Phase 8.7) — folder picker + the currently
  // resolved path, plus a way back to the default.
  const pickHarnessHome = async (): Promise<void> => {
    const picked = await window.api.chooseFolder();
    if (picked) setHarnessHomeDir(picked);
  };

  // Esc closes, matching the sessions overview / new-session modals.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const shiny = shinyConfig();
  const evo = evolutionConfig();

  return (
    <>
      {open && <div className="settings-backdrop" onClick={() => setOpen(false)} />}
      <aside className={open ? 'settings-panel open' : 'settings-panel'} aria-hidden={!open}>
        <header className="settings-head">
          <h2>settings</h2>
          <button className="icon tip" data-tip="close" aria-label="close settings" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>appearance</h3>
          <div className="segmented" role="group" aria-label="theme">
            {(['system', 'light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={appSettings.theme === mode ? 'segmented-btn active' : 'segmented-btn'}
                aria-pressed={appSettings.theme === mode}
                onClick={() => setTheme(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>automation</h3>
          {AUTO_MODE_PROVIDERS.map((p) => {
            const on = appSettings.autoModeByProvider[p.id] ?? false;
            return (
              <label key={p.id} className="settings-row">
                <input type="checkbox" checked={on} onChange={(e) => setAutoMode(p.id, e.target.checked)} />
                <span className="settings-row-text">
                  <span className="settings-row-label">{p.label} auto mode</span>
                  <span className="settings-row-hint">
                    {on ? 'agents act without asking first' : 'agents pause for your approval in the terminal'}
                  </span>
                </span>
              </label>
            );
          })}

          <label className="settings-row">
            <input type="checkbox" checked={appSettings.keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
            <span className="settings-row-text">
              <span className="settings-row-label">keep Mac awake</span>
              <span className="settings-row-hint">
                {appSettings.keepAwake && liveSessionCount > 0
                  ? `keeping your mac awake — ${liveSessionCount} session${liveSessionCount === 1 ? '' : 's'} live`
                  : `off: your Mac can sleep normally${appSettings.keepAwake ? ' (no sessions running)' : ''}`}
              </span>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>harness home</h3>
          <p className="hint">
            where the harness keeps agent-facing files — workspace list, and (later) per-agent memory.
          </p>
          <div className="row harness-home-row">
            <input value={harnessHomePath} readOnly spellCheck={false} title={harnessHomePath} />
            <button type="button" onClick={() => void pickHarnessHome()}>
              choose…
            </button>
          </div>
          {appSettings.harnessHomeDir && (
            <button type="button" onClick={() => setHarnessHomeDir(null)}>
              reset to default
            </button>
          )}
          <p className="hint">
            changing this only points future writes at the new folder — nothing already on disk moves.
          </p>
        </section>

        <section className="settings-section">
          <h3>arceus</h3>
          <p className="hint">
            onboarded once — after that he&apos;s auto-summoned on every launch, no setup dialog.
          </p>
          <button type="button" onClick={() => setResetArceusOpen(true)}>
            reset arceus…
          </button>
        </section>

        <section className="settings-section">
          <h3>sound</h3>
          <label className="audio-row audio-row-master">
            <input
              type="checkbox"
              checked={settings.masterMuted}
              onChange={(e) => setMasterMuted(e.target.checked)}
            />
            mute all
          </label>

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.musicOn} onChange={(e) => setMusicOn(e.target.checked)} />
              music
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

          {settings.musicOn && <MiniPlayer />}

          <div className="audio-row">
            <label className="audio-toggle">
              <input type="checkbox" checked={settings.sfxOn} onChange={(e) => setSfxOn(e.target.checked)} />
              sfx
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
          <h3>terminal</h3>
          <div className="audio-row">
            <span>font size</span>
            <input
              type="range"
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={1}
              value={terminalSettings.fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              aria-label="terminal font size"
            />
            <span className="hint">{terminalSettings.fontSize}px</span>
          </div>
          <div className="audio-row">
            <span>scrollback</span>
            <input
              type="range"
              min={TERMINAL_SCROLLBACK_MIN}
              max={TERMINAL_SCROLLBACK_MAX}
              step={1000}
              value={terminalSettings.scrollback}
              onChange={(e) => setScrollback(Number(e.target.value))}
              aria-label="terminal scrollback depth"
            />
            <span className="hint">{terminalSettings.scrollback.toLocaleString()} lines</span>
          </div>
        </section>

        <section className="settings-section">
          <h3>config</h3>
          <p className="hint settings-config-note">
            env-only knobs (POKE_SHINY_ODDS / POKE_EVOLVE_SECONDS) — read-only here.
          </p>
          <dl className="settings-config-list">
            <dt>shiny odds</dt>
            <dd>1 in {shiny.odds}</dd>
            <dt>evolve to stage 2</dt>
            <dd>{Math.round(evo.stage2Ms / 1000)}s worked</dd>
            <dt>evolve to stage 3</dt>
            <dd>{Math.round(evo.stage3Ms / 1000)}s worked</dd>
          </dl>
        </section>

        <section className="settings-section">
          <h3>closing time</h3>
          <p className="hint">
            every session's Pokémon heads for the garden gate and waves out, then the app quits. esc cancels.
          </p>
          <button type="button" onClick={() => startClosingTime()}>
            wrap up &amp; quit <span className="hint">⌘⇧Q</span>
          </button>
        </section>

        <section className="settings-section">
          <h3>about</h3>
          <div className="row settings-version-row">
            <span>pokéharness {appVersion && `v${appVersion}`}</span>
            <button type="button" onClick={() => void checkForUpdateNow()} disabled={checkStatus === 'checking'}>
              {checkStatus === 'checking' ? 'checking…' : 'check now'}
            </button>
          </div>
          {(checkStatus === 'up to date' || checkStatus === 'checked — offline?') && (
            <p className="hint">{checkStatus}</p>
          )}
        </section>
      </aside>
      {resetArceusOpen && <ResetArceusDialog onClose={() => setResetArceusOpen(false)} />}
    </>
  );
}
