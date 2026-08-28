import { useTerminalSettingsStore } from '@/terminal/terminalSettingsStore';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '@shared/terminalTypes';

interface Props {
  label: string;
}

/**
 * Munder Difflin restyle — the framed terminal panel's own mini header
 * (FocusView.tsx's `.terminal-panel`). ALWAYS rendered, same as the panel
 * wrapper around it: FocusView.tsx's mount-point comment requires the
 * terminal's DOM host to never conditionally (re)mount across a viewMode
 * toggle, so this sits as a permanent sibling above `.terminal-mount-wrap`
 * and index.css's `.terminal-panel-head` rule (display:none outside
 * 'terminal' view mode) hides it everywhere else via CSS, not JSX.
 *
 * Left: a live dot + "live · <session>". Right: a font-size stepper wired to
 * `terminalSettingsStore` — the SAME store SettingsPanel.tsx's slider
 * already reads/writes, so a change here is global (every mounted terminal),
 * which is the simpler and more useful behavior than a parallel per-panel
 * setting. Clamped to the store's own existing range (10-18px,
 * `clampTerminalSettings`) rather than inventing a new one.
 */
export function FocusTerminalHead({ label }: Props): JSX.Element {
  const fontSize = useTerminalSettingsStore((s) => s.settings.fontSize);
  const setFontSize = useTerminalSettingsStore((s) => s.setFontSize);

  return (
    <div className="terminal-panel-head">
      <span className="terminal-panel-live">
        <span className="terminal-panel-live-dot" aria-hidden="true" />
        live · {label}
      </span>
      <div className="terminal-panel-fontstep">
        <button
          type="button"
          className="terminal-panel-fontstep-btn"
          onClick={() => setFontSize(fontSize - 1)}
          disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
          aria-label="decrease terminal font size"
        >
          −
        </button>
        <span className="terminal-panel-fontstep-value">{fontSize}px</span>
        <button
          type="button"
          className="terminal-panel-fontstep-btn"
          onClick={() => setFontSize(fontSize + 1)}
          disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
          aria-label="increase terminal font size"
        >
          +
        </button>
      </div>
    </div>
  );
}
