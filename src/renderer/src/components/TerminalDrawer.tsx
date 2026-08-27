import { useEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { attachTerminal, detachTerminal, focusTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { stopSession } from '@/sessions';

/** Side panel showing the SELECTED session's terminal. Only one terminal is
 *  mounted at a time — see terminalRegistry for why (WebGL context budget). */
export function TerminalDrawer(): JSX.Element | null {
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const open = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const select = useStore((s) => s.select);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!open || !el || !selectedId || !hasTerminal(selectedId)) return;
    attachTerminal(selectedId, el);
    focusTerminal(selectedId);
    return () => detachTerminal(selectedId);
    // Deliberately NOT keyed on the session list: re-attaching on every
    // spawn/kill would churn the terminal's WebGL context for no reason.
  }, [open, selectedId]);

  if (!open) return null;

  const session = sessions.find((s) => s.id === selectedId);

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <div className="drawer-tabs">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={s.id === selectedId ? 'tab active' : 'tab'}
              onClick={() => select(s.id)}
              style={{ borderBottomColor: `#${s.accent.toString(16).padStart(6, '0')}` }}
            >
              {s.title}
            </button>
          ))}
        </div>
        <button className="icon" title="Hide terminal" onClick={() => setDrawerOpen(false)}>
          ×
        </button>
      </header>

      {session ? (
        <>
          <div className="drawer-meta">
            <span className={`status ${session.status}`}>{session.status}</span>
            <span className="path" title={session.cwd}>
              {session.cwd}
            </span>
            <button className="danger" onClick={() => void stopSession(session.id)}>
              Kill
            </button>
          </div>
          {session.error && <p className="error drawer-error">{session.error}</p>}
          <div className="terminal-mount" ref={mountRef} />
        </>
      ) : (
        <p className="empty">No session selected.</p>
      )}
    </aside>
  );
}
