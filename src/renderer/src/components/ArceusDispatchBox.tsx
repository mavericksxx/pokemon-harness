import { useState } from 'react';
import { formatRosterLine } from '@shared/arceus';
import { useStore } from '@/store/store';
import { toRosterEntries } from '@/arceus';

interface Props {
  sessionId: string;
}

/** Dispatch box (Phase 8.8 §6, re-enabled for BACKLOG "next up" item 3) — a
 *  one-line convenience prompt-bar shown ABOVE the terminal only while
 *  Arceus is the selected session. Typing a task and hitting Enter (or the
 *  send button) writes it straight into his session's stdin, same as typing
 *  it directly in his terminal — Arceus still just plans/responds in his own
 *  terminal underneath; the only thing this box adds over typing directly is
 *  prepending a fresh, compact roster tag (item 3 §2's "stay current"
 *  mechanism — see shared/arceus.ts's `formatRosterLine`) so Arceus always
 *  has an up-to-date view of who's in the garden when the user assigns a
 *  task, without a separate change-triggered watcher. `\r` (not `\n`)
 *  matches what a real terminal sends on Enter — the same byte xterm.js's
 *  own `onData` forwards for a literal keypress. */
export function ArceusDispatchBox({ sessionId }: Props): JSX.Element {
  const [text, setText] = useState('');

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const roster = formatRosterLine(toRosterEntries(useStore.getState().sessions));
    void window.api.writePty(sessionId, `${roster} ${trimmed}\r`);
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
        placeholder="ask arceus to assign a task…"
        spellCheck={false}
      />
      <button type="button" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}
