import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useTerminalSettingsStore } from '@/terminal/terminalSettingsStore';
import { showUpdateToast } from '@/updateNotifier';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@shared/terminalTypes';

/**
 * Topbar "quick settings" popover — the handful of things worth reaching
 * mid-flow without leaving the garden for the full settings dialog
 * (SettingsPanel.tsx): theme, the claude provider's auto-mode, keep-awake,
 * and an on-demand update check. Same anchored-popover shape as
 * AudioPopover.tsx (pointerdown outside-click dismissal, Escape closes).
 * Mute-all and the music volume control live in the sound icon's own
 * popover (AudioPopover.tsx) — not duplicated here. HARNESS.md loading
 * lives in the full settings dialog's "harness home" section.
 *
 * Topbar overhaul (BACKLOG.md phase B "merge quick settings into the gear"):
 * this IS the settings entry point now — the trigger is the ⚙ gear glyph
 * (was a separate sliders icon sitting beside a second, plain gear button
 * that opened SettingsPanel directly; the two side by side read as
 * confusing/duplicated). One gear, one popover; its own "all settings…" row
 * below still opens the full SettingsPanel dialog. Self-contained on purpose
 * (mount point: App.tsx's `.topbar-actions` cluster, last item) — this
 * component owns its own trigger, popover, and CSS block.
 */
export function QuickSettings(): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const setFullSettingsOpen = useStore((s) => s.setSettingsOpen);

  const appSettings = useAppSettingsStore((s) => s.settings);
  const setTheme = useAppSettingsStore((s) => s.setTheme);
  const setAutoMode = useAppSettingsStore((s) => s.setAutoMode);
  const setKeepAwake = useAppSettingsStore((s) => s.setKeepAwake);
  const claudeAutoMode = appSettings.autoModeByProvider.claude ?? false;

  const terminalFontSize = useTerminalSettingsStore((s) => s.settings.fontSize);
  const setTerminalFontSize = useTerminalSettingsStore((s) => s.setFontSize);

  const [updateCheckStatus, setUpdateCheckStatus] = useState<
    'idle' | 'checking' | 'up to date' | 'checked — offline?'
  >('idle');
  // Same one-time-on-mount fetch as SettingsPanel's "about" section —
  // shown next to "check for updates" so this popover's own check row
  // reads the same as that page's version row.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Outside-click dismissal follows the document-level pointerdown +
  // wrapper-ref `.contains()` pattern already established by
  // OverflowChipRow.tsx, instead of using a full-screen catcher div.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const openFullSettings = (): void => {
    setOpen(false);
    setFullSettingsOpen(true);
  };

  const checkForUpdateNow = async (): Promise<void> => {
    setUpdateCheckStatus('checking');
    const result = await window.api.checkForUpdateNow();
    if (result?.available) {
      showUpdateToast(result);
      setUpdateCheckStatus('idle');
    } else {
      setUpdateCheckStatus(result ? 'up to date' : 'checked — offline?');
    }
  };

  return (
    <div className="quick-settings" ref={wrapperRef}>
      <button
        type="button"
        className="topbar-icon-btn tip"
        data-tip="settings"
        aria-label="settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        ⚙
      </button>

      {open && (
        <div className="quick-settings-panel" role="dialog" aria-label="settings">
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

          <label className="settings-row">
            <input
              type="checkbox"
              checked={claudeAutoMode}
              onChange={(e) => setAutoMode('claude', e.target.checked)}
            />
            <span className="settings-row-text">
              <span className="settings-row-label">claude auto mode</span>
              <span className="settings-row-hint">
                {claudeAutoMode ? 'acts without asking first' : 'pauses for your approval in the terminal'}
              </span>
            </span>
          </label>

          <label className="settings-row">
            <input type="checkbox" checked={appSettings.keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
            <span className="settings-row-text">
              <span className="settings-row-label">keep Mac awake</span>
              <span className="settings-row-hint">
                {appSettings.keepAwake ? 'your mac stays awake while sessions run' : 'your mac can sleep normally'}
              </span>
            </span>
          </label>

          <div className="audio-row">
            <span>terminal font size</span>
            <div className="terminal-panel-fontstep">
              <button
                type="button"
                className="terminal-panel-fontstep-btn"
                onClick={() => setTerminalFontSize(terminalFontSize - 1)}
                disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
                aria-label="decrease terminal font size"
              >
                −
              </button>
              <span className="terminal-panel-fontstep-value">{terminalFontSize}px</span>
              <button
                type="button"
                className="terminal-panel-fontstep-btn"
                onClick={() => setTerminalFontSize(terminalFontSize + 1)}
                disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
                aria-label="increase terminal font size"
              >
                +
              </button>
            </div>
          </div>

          <div className="quick-settings-update">
            <button
              type="button"
              className="quick-settings-all"
              onClick={() => void checkForUpdateNow()}
              disabled={updateCheckStatus === 'checking'}
            >
              {updateCheckStatus === 'checking' ? 'checking…' : 'check for updates'}
              {appVersion && ` (v${appVersion})`}
            </button>
            {updateCheckStatus !== 'idle' && updateCheckStatus !== 'checking' && (
              <p className="hint" aria-live="polite">
                {updateCheckStatus}
              </p>
            )}
          </div>

          <button type="button" className="quick-settings-all" onClick={openFullSettings}>
            all settings…
          </button>
        </div>
      )}
    </div>
  );
}
