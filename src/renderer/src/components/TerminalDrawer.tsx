import { useEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { attachTerminal, detachTerminal, focusTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { stopSession } from '@/sessions';
import { statusLabel } from '@/design/statusLabel';

/** Side panel showing the SELECTED session's terminal. Only one terminal is
 *  mounted at a time — see terminalRegistry for why (WebGL context budget). */
export function TerminalDrawer(): JSX.Element | null {
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const drawerOpenPref = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const select = useStore((s) => s.select);
  const viewMode = useStore((s) => s.viewMode);
  const mountRef = useRef<HTMLDivElement>(null);

  // Phase 8 §1: 'terminal'/'terminalFull' always show the terminal (it IS the
  // view); 'gardenFull' never does; 'garden' keeps the old manual toggle.
  const open =
    viewMode === 'terminal' || viewMode === 'terminalFull' || (viewMode === 'garden' && drawerOpenPref);
  // Full-bleed in the two terminal-owning modes — no side-panel width cap.
  const wide = viewMode !== 'garden';
  // The sidebar (terminal-focus mode) already offers session switching; the
  // drawer's own tab strip would just duplicate it.
  const showTabs = viewMode !== 'terminal';

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
    <aside className={wide ? 'drawer drawer-wide' : 'drawer'}>
      {showTabs && (
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
          {viewMode === 'garden' && (
            <button className="icon tip" data-tip="Hide terminal" onClick={() => setDrawerOpen(false)}>
              ×
            </button>
          )}
        </header>
      )}

      {session ? (
        <>
          <div className="drawer-meta">
            <span className={`status ${session.status}`}>{statusLabel(session.status)}</span>
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
        <p className="empty">Pick a session to see what's happening.</p>
      )}
    </aside>
  );
}
