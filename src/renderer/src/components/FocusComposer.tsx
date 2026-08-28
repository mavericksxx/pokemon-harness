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
 *  (ArceusDispatchBox.tsx) is the composer there — see FocusView.tsx. */
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
      <div className="focus-composer-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="type a message — queues if the agent's busy… (shift+enter for a new line)"
          spellCheck={false}
          rows={1}
        />
        <button type="button" onClick={send} disabled={!text.trim()}>
          queue
        </button>
      </div>
    </div>
  );
}
