import { useState } from 'react';
import type { Session } from '@/store/store';
import { removeFocusQueueItem, submitFocusMessage, useFocusQueue } from '@/pty/focusQueue';

interface Props {
  session: Session;
}

/** BACKLOG phase E — the 'terminal' view mode command center's bottom
 *  composer, one per session. Submitting injects the message into the
 *  session's pty immediately if it's idle, or queues it (shown above the
 *  input as a small removable chip, "queued · sends when idle") for
 *  delivery the moment the session next goes idle — see
 *  src/renderer/src/pty/focusQueue.ts, which reuses main/arceusRelay.ts's
 *  idle-queue safety rail (never type into a non-idle session) through the
 *  shared `InjectionQueue` (shared/injectionQueue.ts). A `<textarea>`, not a
 *  plain input, so a multiline paste keeps its newlines rather than a bare
 *  `<input>` silently collapsing them — shift+enter inserts a line the same
 *  way; enter alone sends. Never rendered for Arceus, whose own dispatch box
 *  (ArceusDispatchBox.tsx) is the composer there — see FocusView.tsx.
 *
 *  Munder Difflin restyle (backlog item): same submit logic/keybinding as
 *  before (send/queue semantics untouched — see focusQueue.ts), just a
 *  taller multiline textarea under a pixel-caps "queue" label instead of a
 *  single-line row, with the send button moved below and right-aligned. */
export function FocusComposer({ session }: Props): JSX.Element {
  const [text, setText] = useState('');
  const queued = useFocusQueue(session.id);

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    submitFocusMessage(session.id, trimmed);
    setText('');
  };

  return (
    <div className="focus-composer">
      <span className="focus-composer-label">queue</span>
      {queued.length > 0 && (
        <div className="focus-composer-queue">
          {queued.map((item, i) => (
            <span key={i} className="focus-queue-chip" title="queued · sends when idle">
              {item.text}
              <button
                type="button"
                className="icon"
                onClick={() => removeFocusQueueItem(session.id, i)}
                aria-label="remove queued message"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={`message ${session.title} — queues if the agent's busy… (shift+enter for a new line)`}
        spellCheck={false}
        rows={4}
      />
      <div className="focus-composer-actions">
        <button type="button" className="primary" onClick={send} disabled={!text.trim()}>
          send →
        </button>
      </div>
    </div>
  );
}
