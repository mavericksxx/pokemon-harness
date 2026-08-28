import { useStore } from '@/store/store';
import { AgentRosterCard } from '@/components/AgentRosterCard';

/** Full-roster grid (Phase 8 §3/§7) — opened from the topbar button or the
 *  garden's signpost prop. Picking a card selects that session and switches
 *  to terminal-focus so the pick has somewhere to land. */
export function SessionsOverview(): JSX.Element | null {
  const open = useStore((s) => s.sessionsOverviewOpen);
  const setOpen = useStore((s) => s.setSessionsOverviewOpen);
  const sessions = useStore((s) => s.sessions);
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
          <p className="empty">No sessions yet — start one from the topbar.</p>
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
