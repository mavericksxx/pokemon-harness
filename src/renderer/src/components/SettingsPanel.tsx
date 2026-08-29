import { Fragment, useEffect, useState } from 'react';
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
import type { DiagnosticsInfo } from '@shared/diagnosticsTypes';
import type { UsageProviderId } from '@shared/usageTypes';

/** Providers whose auto-permission-mode is actually wireable (parity sweep
 *  item 1) — the ones with a verified `autoModeArgs` in agentProvider.ts. */
const AUTO_MODE_PROVIDERS = PROVIDER_LIST.filter((p) => p.autoModeArgs);

/** The usage-limits panel's own per-provider include/exclude rows (user
 *  feedback: "let the user pick which providers to include ... i dont wanna
 *  include codex only claude"). Deliberately its own short list rather than
 *  reusing `AGENT_PROVIDERS`' labels — those are display-cased ("Claude
 *  Code"), this section's copy is lowercase to match the rest of this
 *  panel's own row labels ("show provider usage limits", "keep Mac awake"). */
const USAGE_PROVIDERS: { id: UsageProviderId; label: string }[] = [
  { id: 'claude', label: 'claude code' },
  { id: 'codex', label: 'codex cli' }
];

/**
 * Left-rail section list for the settings dialog. Order matches the brief
 * ("appearance, automation, harness home, arceus, sound, diagnostics") with
 * the panel's other pre-existing sections (terminal, config, closing time,
 * about) kept in their original relative position between "sound" and
 * "diagnostics" — nothing dropped, just re-housed. Change this array to
 * reorder/merge sections; both the rail and the content switch below read
 * off it.
 */
const SECTIONS = [
  { id: 'appearance', label: 'appearance' },
  { id: 'automation', label: 'automation' },
  { id: 'usage', label: 'usage' },
  { id: 'harness-home', label: 'harness home' },
  { id: 'arceus', label: 'arceus' },
  { id: 'sound', label: 'sound' },
  { id: 'terminal', label: 'terminal' },
  { id: 'config', label: 'config' },
  { id: 'closing-time', label: 'closing time' },
  { id: 'about', label: 'about' },
  { id: 'diagnostics', label: 'diagnostics' }
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * Phase 8 §5 (settings redesign) — was a right-edge slide-in panel, now a
 * centered dialog matching the app's `.modal`/`.modal-backdrop` conventions
 * (QuitDialog/NewSessionDialog): backdrop click and Escape both close it,
 * Cmd/Ctrl has nothing to do with it. Structured as a real settings page —
 * a left rail of section links with the active section's content on the
 * right, one section visible at a time instead of one long scrolling column.
 *
 * Every control below is unchanged from the pre-redesign panel (same
 * stores, same pixel checkbox/slider skin — now scoped to `.settings-dialog`
 * instead of `.settings-panel`, see index.css) — this pass only changes the
 * chrome around them, not what they do.
 */
export function SettingsPanel(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');
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
const setHideClaudeStatusline = useAppSettingsStore((s) => s.setHideClaudeStatusline);
  const setUsageLimitsEnabled = useAppSettingsStore((s) => s.setUsageLimitsEnabled);
  const setUsageProviderEnabled = useAppSettingsStore((s) => s.setUsageProviderEnabled);
  const setDiagnosticsLoggingEnabled = useAppSettingsStore((s) => s.setDiagnosticsLoggingEnabled);
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

  // Diagnostics (BACKLOG item 1) — version/logs-path/error-count row.
  // Polled every few seconds while the panel is open (not pushed — main has
  // no reason to know or care whether Settings is on screen) so the
  // error-count stays roughly live without a dedicated push channel.
  const [diagnosticsInfo, setDiagnosticsInfo] = useState<DiagnosticsInfo | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = (): void => {
      void window.api.getDiagnosticsInfo().then((info) => {
        if (!cancelled) setDiagnosticsInfo(info);
      });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open]);

  // Export diagnostics bundle (BACKLOG friend-testing readiness) — same
  // busy/status pattern as the "about" section's update-check button below.
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'done' | 'error' | 'canceled'>('idle');
  const exportBundle = async (): Promise<void> => {
    setExportStatus('exporting');
    const res = await window.api.exportDiagnosticsBundle();
    if (res.ok) setExportStatus('done');
    else setExportStatus('canceled' in res && res.canceled ? 'canceled' : 'error');
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

  // Every open starts back at the first section — mirrors most settings
  // pages (System Preferences, VS Code) rather than remembering where you
  // last were.
  useEffect(() => {
    if (open) setActiveSection('appearance');
  }, [open]);

  if (!open) return null;

  const shiny = shinyConfig();
  const evo = evolutionConfig();
  const activeLabel = SECTIONS.find((s) => s.id === activeSection)?.label ?? '';

  return (
    <>
      <div className="modal-backdrop" onClick={() => setOpen(false)}>
        <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
          <nav className="settings-rail">
            {SECTIONS.map((s) => (
              <Fragment key={s.id}>
                {/* Separates the app-behavior sections above from the
                    meta/utility pair below (settings redesign — optional
                    rail divider per the design brief). */}
                {s.id === 'about' && <div className="settings-rail-divider" />}
                <button
                  type="button"
                  className={activeSection === s.id ? 'settings-rail-btn active' : 'settings-rail-btn'}
                  aria-current={activeSection === s.id}
                  onClick={() => setActiveSection(s.id)}
                >
                  {s.label}
                </button>
              </Fragment>
            ))}
          </nav>

          <div className="settings-content">
            <header className="settings-content-head">
              <h2>{activeLabel}</h2>
              <button
                className="icon tip"
                data-tip="close"
                aria-label="close settings"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>

            <div className="settings-content-body">
              {activeSection === 'appearance' && (
                <div className="settings-card">
                  <div className="settings-card-row">
                    <span className="settings-row-label">theme</span>
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
                  </div>
                </div>
              )}

              {activeSection === 'automation' && (
                <div className="settings-card">
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
                    <input
                      type="checkbox"
                      checked={appSettings.keepAwake}
                      onChange={(e) => setKeepAwake(e.target.checked)}
                    />
                    <span className="settings-row-text">
                      <span className="settings-row-label">keep Mac awake</span>
                      <span className="settings-row-hint">
                        {appSettings.keepAwake && liveSessionCount > 0
                          ? `keeping your mac awake — ${liveSessionCount} session${liveSessionCount === 1 ? '' : 's'} live`
                          : `off: your Mac can sleep normally${appSettings.keepAwake ? ' (no sessions running)' : ''}`}
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {activeSection === 'usage' && (
                <>
                  <div className="settings-card">
                    <label className="settings-row">
                      <input
                        type="checkbox"
                        checked={appSettings.usageLimitsEnabled}
                        onChange={(e) => setUsageLimitsEnabled(e.target.checked)}
                      />
                      <span className="settings-row-text">
                        <span className="settings-row-label">show provider usage limits</span>
                        <span className="settings-row-hint">
                          reads the credential your CLI already stores to ask its usage endpoint. read-only — never
                          stored, refreshed, or sent anywhere else. off = never touched. first keychain read will
                          trigger a one-time macOS permission prompt.
                        </span>
                      </span>
                    </label>
                  </div>

                  <div
                    className={`settings-card settings-usage-providers${appSettings.usageLimitsEnabled ? '' : ' is-disabled'}`}
                  >
                    <p className="settings-card-label">include in usage metrics</p>
                    {USAGE_PROVIDERS.map((p) => (
                      <label key={p.id} className="settings-usage-provider-row">
                        <input
                          type="checkbox"
                          checked={!appSettings.usageExcludedProviders.includes(p.id)}
                          disabled={!appSettings.usageLimitsEnabled}
                          onChange={(e) => setUsageProviderEnabled(p.id, e.target.checked)}
                        />
                        <span className="settings-row-label">{p.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {activeSection === 'harness-home' && (
                <div className="settings-card">
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
                </div>
              )}

              {activeSection === 'arceus' && (
                <div className="settings-card">
                  <p className="hint">
                    onboarded once — after that he&apos;s auto-summoned on every launch, no setup dialog.
                  </p>
                  <button type="button" onClick={() => setResetArceusOpen(true)}>
                    reset arceus…
                  </button>
                </div>
              )}

              {activeSection === 'sound' && (
                <div className="settings-card">
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
                </div>
              )}

              {activeSection === 'terminal' && (
                <div className="settings-card">
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
                  <label className="settings-row">
                    <input
                      type="checkbox"
                      checked={appSettings.hideClaudeStatusline}
                      onChange={(e) => setHideClaudeStatusline(e.target.checked)}
                    />
                    <span className="settings-row-text">
                      <span className="settings-row-label">hide claude statusline</span>
                      <span className="settings-row-hint">
                        hides your claude code statusline in pokéharness terminals only — other terminals keep it.
                        also hides claude's footer hints (esc to interrupt, ? for shortcuts). applies to newly
                        started sessions.
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {activeSection === 'config' && (
                <div className="settings-card">
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
                </div>
              )}

              {activeSection === 'closing-time' && (
                <div className="settings-card">
                  <p className="hint">
                    every session's Pokémon heads for the garden gate and waves out, then the app quits. esc cancels.
                  </p>
                  <button type="button" onClick={() => startClosingTime()}>
                    wrap up &amp; quit <span className="hint">⌘⇧Q</span>
                  </button>
                </div>
              )}

              {activeSection === 'about' && (
                <div className="settings-card">
                  <div className="row settings-version-row">
                    <span>pokéharness {appVersion && `v${appVersion}`}</span>
                    <button type="button" onClick={() => void checkForUpdateNow()} disabled={checkStatus === 'checking'}>
                      {checkStatus === 'checking' ? 'checking…' : 'check now'}
                    </button>
                  </div>
                  {(checkStatus === 'up to date' || checkStatus === 'checked — offline?') && (
                    <p className="hint">{checkStatus}</p>
                  )}
                </div>
              )}

              {activeSection === 'diagnostics' && (
                <div className="settings-card">
                  <p className="hint">local-only — logs stay on this machine and are only shared if you export them below.</p>
                  <label className="settings-row">
                    <input
                      type="checkbox"
                      checked={appSettings.diagnosticsLoggingEnabled}
                      onChange={(e) => setDiagnosticsLoggingEnabled(e.target.checked)}
                    />
                    <span className="settings-row-text">
                      <span className="settings-row-label">diagnostics logging</span>
                      <span className="settings-row-hint">
                        {appSettings.diagnosticsLoggingEnabled
                          ? 'logging the routine stuff (counters, battle events) alongside errors.'
                          : 'off: routine logging is paused. errors are always captured — they\'re cheap, and losing them defeats the point of a bug report.'}
                      </span>
                    </span>
                  </label>
                  <dl className="settings-config-list">
                    <dt>app version</dt>
                    <dd>{diagnosticsInfo?.appVersion || '—'}</dd>
                    <dt>electron</dt>
                    <dd>{diagnosticsInfo?.electronVersion || '—'}</dd>
                    <dt>errors this session</dt>
                    <dd>{diagnosticsInfo ? diagnosticsInfo.recentErrorCount : '—'}</dd>
                  </dl>
                  <div className="row harness-home-row">
                    <input
                      value={diagnosticsInfo?.logDir ?? ''}
                      readOnly
                      spellCheck={false}
                      title={diagnosticsInfo?.logDir ?? ''}
                    />
                    <button type="button" onClick={() => void window.api.openLogsFolder()}>
                      open logs folder
                    </button>
                  </div>
                  <div className="row settings-version-row">
                    <button type="button" onClick={() => void exportBundle()} disabled={exportStatus === 'exporting'}>
                      {exportStatus === 'exporting' ? 'exporting…' : 'export diagnostics bundle'}
                    </button>
                  </div>
                  {exportStatus === 'done' && <p className="hint">saved — revealed in Finder.</p>}
                  {exportStatus === 'error' && <p className="hint">export failed — try again, or use "open logs folder" instead.</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {resetArceusOpen && <ResetArceusDialog onClose={() => setResetArceusOpen(false)} />}
    </>
  );
}
