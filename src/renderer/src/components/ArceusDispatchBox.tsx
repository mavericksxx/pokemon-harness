import { useState } from 'react';

interface Props {
  sessionId: string;
}

/** Dispatch box (Phase 8.8 §6) — a one-line convenience prompt-bar shown
 *  ABOVE the terminal only while Arceus is the selected session. Typing a
 *  task and hitting Enter (or the send button) writes it straight into his
 *  session's stdin, same as typing it directly in his terminal — this
 *  phase doesn't build real agent-to-agent messaging (that's Phase 8.9);
 *  Arceus still just plans/responds in his own terminal underneath. `\r`
 *  (not `\n`) matches what a real terminal sends on Enter — the same byte
 *  xterm.js's own `onData` forwards for a literal keypress. */
export function ArceusDispatchBox({ sessionId }: Props): JSX.Element {
  const [text, setText] = useState('');

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void window.api.writePty(sessionId, trimmed + '\r');
    setText('');
  };

  return (
    <div className="dispatch-box">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
        placeholder="describe the task — arceus assigns it"
        spellCheck={false}
      />
      <button type="button" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}
