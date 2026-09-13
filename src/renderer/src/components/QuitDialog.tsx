import { useStore } from '@/store/store';
import { sessionWorkspaceId } from '@/store/workspaceStore';
import { useEscapeToClose } from './useEscapeToClose';

/**
 * Quit-intercept dialog (parity sweep item 2). Main prevents an actual QUIT
 * (Cmd+Q / Dock quit / app-menu Quit) whenever sessions are still live and
 * asks the renderer to show this instead (see updateNotifier.ts's
 * `startQuitInterceptListener`) — two actions: cancel, or quit and leave
 * every session running in the background (reattached on the next launch —
 * see main/pty.ts's `detachAllToKeepers`/`tryReattach`). A plain window
 * close (traffic light / Cmd+W) never triggers this — it just hides the
 * window. No dialog when zero sessions are live: main only ever sends the
 * request in that case, so this component just never opens.
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

  const keepRunning = (): void => {
    setOpen(false);
  };

  useEscapeToClose(keepRunning, open);

  if (!open) return null;

  const leaveRunningAndQuit = (): void => {
    setOpen(false);
    void window.api.leaveRunningAndQuit();
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
          they&apos;ll keep working in the background and reattach next launch.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={keepRunning}>
            cancel
          </button>
          <button type="button" className="primary" onClick={leaveRunningAndQuit} autoFocus>
            quit
          </button>
        </div>
      </div>
    </div>
  );
}
