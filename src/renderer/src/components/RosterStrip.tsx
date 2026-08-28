import { useMemo } from 'react';
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
 * another workspace has no card here until you switch to it. Arceus
 * (Phase 8.8) is global, so `useActiveWorkspaceSessions` already includes
 * him regardless of which workspace is active; this component's own job is
 * just pinning his card FIRST — a stable sort (every other session keeps
 * its existing relative order) rather than a fresh sort by some other key.
 */
export function RosterStrip({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(
    () => [...activeWorkspaceSessions].sort((a, b) => (b.isArceus ? 1 : 0) - (a.isArceus ? 1 : 0)),
    [activeWorkspaceSessions]
  );
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
