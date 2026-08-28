import { useStore } from '@/store/store';
import { sessionWorkspaceId } from '@/store/workspaceStore';
import { startClosingTime } from '@/closingTime';

/**
 * Quit-intercept dialog (parity sweep item 2). Main prevents a close/quit
 * whenever sessions are still live and asks the renderer to show this
 * instead (see closingTime.ts's `startQuitInterceptListener`) — three
 * actions: cancel, run the existing sunset ritual, or kill everything and
 * quit immediately. No dialog when zero sessions are live: main only ever
 * sends the request in that case, so this component just never opens.
 *
 * `count` (main's own authoritative live-session count) spans every
 * workspace already (Phase 8.7 — main's ptyManager isn't workspace-scoped);
 * this only adds the "across N gardens" qualifier when those live sessions
 * are spread across more than one.
 */
export function QuitDialog(): JSX.Element | null {
  const open = useStore((s) => s.quitDialogOpen);
  const count = useStore((s) => s.quitDialogCount);
  const setOpen = useStore((s) => s.setQuitDialogOpen);
  const sessions = useStore((s) => s.sessions);
  const liveWorkspaceCount = new Set(
    sessions.filter((s) => s.status !== 'done').map((s) => sessionWorkspaceId(s))
  ).size;

  if (!open) return null;

  const keepRunning = (): void => setOpen(false);
  const closingTime = (): void => {
    setOpen(false);
    startClosingTime();
  };
  const killAndQuit = (): void => {
    setOpen(false);
    void window.api.forceQuit();
  };

  return (
    <div className="modal-backdrop" onClick={keepRunning}>
      <div className="modal quit-dialog-modal" onClick={(e) => e.stopPropagation()}>
        <h2>quitting now?</h2>
        <p className="quit-dialog-count">
          {count} agent{count === 1 ? '' : 's'} still running
          {liveWorkspaceCount > 1 ? ` across ${liveWorkspaceCount} gardens` : ''}
        </p>
        <p className="hint">
          quitting stops every session where it stands. claude sessions resume next launch
          (--resume) — only whatever was still mid-response, plus any shell or codex session, is
          actually gone.
        </p>
        <div className="modal-actions quit-dialog-actions">
          <div className="quit-dialog-action">
            <button type="button" onClick={keepRunning}>
              keep them running
            </button>
            <span className="hint quit-dialog-action-hint">nothing quits — back to the garden</span>
          </div>
          <div className="quit-dialog-action">
            <button type="button" className="danger" onClick={killAndQuit}>
              kill it &amp; quit
            </button>
            <span className="hint quit-dialog-action-hint">
              quit now — claude sessions resume next launch, shells don't
            </span>
          </div>
          <div className="quit-dialog-action">
            <button type="button" className="primary" onClick={closingTime}>
              closing time
            </button>
            <span className="hint quit-dialog-action-hint">
              sunset ritual: everyone wraps up, then the app quits itself
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
