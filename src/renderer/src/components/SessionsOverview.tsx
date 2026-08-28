import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';

/** Full-roster grid (Phase 8 §3/§7) — opened from the topbar button or the
 *  garden's signpost prop. Picking a card selects that session and switches
 *  to terminal-focus so the pick has somewhere to land.
 *
 *  Scoped to the ACTIVE workspace's sessions (Phase 8.7) — same reasoning
 *  as RosterStrip. */
export function SessionsOverview(): JSX.Element | null {
  const open = useStore((s) => s.sessionsOverviewOpen);
  const setOpen = useStore((s) => s.setSessionsOverviewOpen);
  const sessions = useActiveWorkspaceSessions();
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);

  if (!open) return null;

  const pick = (id: string): void => {
    select(id);
    setViewMode('terminal');
    setOpen(false);
  };

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal sessions-overview" onClick={(e) => e.stopPropagation()}>
        <h2>Sessions</h2>
        {sessions.length === 0 ? (
          <p className="empty">No sessions in this workspace yet — start one from the topbar.</p>
        ) : (
          <div className="sessions-overview-grid">
            {sessions.map((s) => (
              <AgentRosterCard key={s.id} session={s} selected={s.id === selectedId} onSelect={pick} />
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
