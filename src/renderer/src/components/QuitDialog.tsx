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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>quitting now?</h2>
        <p className="quit-dialog-count">
          {count} agent{count === 1 ? '' : 's'} still running
          {liveWorkspaceCount > 1 ? ` across ${liveWorkspaceCount} gardens` : ''}
        </p>
        <p className="hint">
          Running sessions get killed and their in-session conversation state is lost.
        </p>
        <div className="modal-actions quit-dialog-actions">
          <button type="button" onClick={keepRunning}>
            keep them running
          </button>
          <button type="button" className="danger" onClick={killAndQuit}>
            kill it &amp; quit
          </button>
          <button type="button" className="primary" onClick={closingTime}>
            closing time
          </button>
        </div>
      </div>
    </div>
  );
}
