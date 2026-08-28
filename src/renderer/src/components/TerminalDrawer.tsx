import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { attachTerminal, detachTerminal, focusTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { stopSession } from '@/sessions';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { TerminalFindBar } from '@/components/TerminalFindBar';

/** Side panel showing the SELECTED session's terminal. Only one terminal is
 *  mounted at a time — see terminalRegistry for why (WebGL context budget).
 *
 *  The tab strip (`.drawer-tabs`) is scoped to the ACTIVE workspace's
 *  sessions (Phase 8.7); the currently-open terminal itself is looked up
 *  against the FULL session list below (`allSessions`) rather than the
 *  scoped one, so a `selectedId` that's momentarily out of sync with the
 *  active workspace (there shouldn't be one — the workspace switch itself
 *  re-points selection — but this is the cheap belt-and-braces read) still
 *  resolves instead of silently rendering the empty state. */
export function TerminalDrawer(): JSX.Element | null {
  const allSessions = useStore((s) => s.sessions);
  const sessions = useActiveWorkspaceSessions();
  const selectedId = useStore((s) => s.selectedId);
  const drawerOpenPref = useStore((s) => s.drawerOpen);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const select = useStore((s) => s.select);
  const viewMode = useStore((s) => s.viewMode);
  const mountRef = useRef<HTMLDivElement>(null);
  // Find-in-scrollback (item 3 §1) — closed whenever the selected session
  // changes, so switching tabs never leaves a stale find bar (and its
  // highlights, scoped to the PREVIOUS session's terminal) hanging around.
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => setFindOpen(false), [selectedId]);

  // Phase 8 §1: 'terminal'/'terminalFull' always show the terminal (it IS the
  // view); 'gardenFull' never does; 'garden' keeps the old manual toggle.
  const open =
    viewMode === 'terminal' || viewMode === 'terminalFull' || (viewMode === 'garden' && drawerOpenPref);
  // Full-bleed in the two terminal-owning modes — no side-panel width cap.
  const wide = viewMode !== 'garden';
  // The bottom roster strip (terminal-focus mode; parity sweep item 5,
  // formerly a left sidebar) already offers session switching; the drawer's
  // own tab strip would just duplicate it.
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

  // Cmd/Ctrl+F opens the find bar instead of the OS/browser's own find —
  // only while a terminal is actually mounted here.
  useEffect(() => {
    if (!open || !selectedId) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, selectedId]);

  if (!open) return null;

  const session = allSessions.find((s) => s.id === selectedId);

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
            <span className={session.napping ? 'status napping' : `status ${session.status}`}>
              {sessionStatusLabel(session)}
            </span>
            <span className="path" title={session.cwd}>
              {session.cwd}
            </span>
            <button className="danger" onClick={() => void stopSession(session.id)}>
              Kill
            </button>
          </div>
          {session.error && <p className="error drawer-error">{session.error}</p>}
          <div className="terminal-mount-wrap">
            <div className="terminal-mount" ref={mountRef} />
            {findOpen && <TerminalFindBar sessionId={session.id} onClose={() => setFindOpen(false)} />}
          </div>
        </>
      ) : (
        <div className="empty-terminal">
          <div className="empty-terminal-glyph" aria-hidden="true" />
          <p className="empty">Pick a session to see what's happening.</p>
        </div>
      )}
    </aside>
  );
}
