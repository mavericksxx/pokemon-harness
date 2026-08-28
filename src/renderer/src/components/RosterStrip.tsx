import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';

interface Props {
  onNewSession(): void;
}

/**
 * Bottom session strip (parity sweep item 5) — a horizontal-scroll row of
 * roster cards replacing the old top-chrome session chips + left sidebar,
 * used in 'garden' and 'terminal' view modes (App.tsx decides which; the two
 * "Full" modes keep the previous topbar chips instead — see App.tsx's own
 * comment for why). "+ new session" sits at the strip's end, not in the top
 * bar. The cards themselves are unchanged (AgentRosterCard) — this is
 * placement/orientation only.
 *
 * Scoped to the ACTIVE workspace's sessions (Phase 8.7) — a session in
 * another workspace has no card here until you switch to it.
 */
export function RosterStrip({ onNewSession }: Props): JSX.Element {
  const sessions = useActiveWorkspaceSessions();
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  return (
    <div className="roster-strip">
      {sessions.map((s) => (
        <AgentRosterCard key={s.id} session={s} selected={s.id === selectedId} onSelect={select} />
      ))}
      <button type="button" className="roster-strip-new" onClick={onNewSession}>
        + new session
      </button>
    </div>
  );
}
