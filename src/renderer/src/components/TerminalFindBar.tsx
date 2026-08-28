import { useEffect, useRef, useState } from 'react';
import { clearSearch, searchNext, searchPrevious } from '@/pty/terminalRegistry';

interface Props {
  sessionId: string;
  onClose(): void;
}

/**
 * Find-in-scrollback (Phase 8.5 Wave B item 3 §1) — a small overlay bar over
 * the visible terminal, opened by Cmd+F (see TerminalDrawer.tsx). Wraps
 * `@xterm/addon-search`'s `findNext`/`findPrevious`, already loaded per
 * terminal in terminalRegistry.ts.
 */
export function TerminalFindBar({ sessionId, onClose }: Props): JSX.Element {
  const [term, setTerm] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scrollback highlights are session-scoped in the addon itself; clear them
  // on close/unmount so a re-open (or a different session) doesn't inherit
  // a stale decoration set.
  useEffect(() => () => clearSearch(sessionId), [sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) searchPrevious(sessionId, term);
      else searchNext(sessionId, term);
    }
  };

  const onChange = (value: string): void => {
    setTerm(value);
    if (value) searchNext(sessionId, value);
    else clearSearch(sessionId);
  };

  return (
    <div className="terminal-find-bar">
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="find in scrollback…"
        spellCheck={false}
      />
      <button
        type="button"
        className="icon tip"
        data-tip="previous (shift+enter)"
        aria-label="previous match"
        onClick={() => searchPrevious(sessionId, term)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon tip"
        data-tip="next (enter)"
        aria-label="next match"
        onClick={() => searchNext(sessionId, term)}
      >
        ↓
      </button>
      <button type="button" className="icon tip" data-tip="close (esc)" aria-label="close find bar" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
