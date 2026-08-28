import { useStore } from '@/store/store';
import { AgentRosterCard } from '@/components/AgentRosterCard';

/** Left sidebar for terminal-focus mode (Phase 8 §1/§3) — a vertical stack of
 *  roster cards; clicking one selects that session (drives the terminal on
 *  the right, and the select-cry interaction — see sessions.ts). */
export function SessionSidebar(): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  return (
    <aside className="roster-sidebar">
      {sessions.length === 0 ? (
        <p className="empty">No sessions yet.</p>
      ) : (
        sessions.map((s) => (
          <AgentRosterCard key={s.id} session={s} selected={s.id === selectedId} onSelect={select} />
        ))
      )}
    </aside>
  );
}
