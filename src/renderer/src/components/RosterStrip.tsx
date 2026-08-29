import { Fragment, useMemo } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { ArceusRosterCard } from '@/components/ArceusRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';

interface Props {
  onNewSession(): void;
}

/**
 * Bottom session strip (parity sweep item 5) — a horizontal-scroll row of
 * roster cards replacing the old top-chrome session chips + left sidebar,
 * used in 'garden' and 'terminal' view modes (App.tsx decides which; the two
 * "Full" modes keep the previous topbar chips instead — see App.tsx's own
 * comment for why). "+ new agent" sits at the strip's end, not in the top
 * bar. The cards themselves are unchanged (AgentRosterCard) — this is
 * placement/orientation only.
 *
 * Scoped to the ACTIVE workspace's sessions (Phase 8.7) — a session in
 * another workspace has no card here until you switch to it. Arceus is
 * global (`useActiveWorkspaceSessions` includes him regardless of which
 * workspace is active) and filtered out of the ordinary `sessions` list
 * below (he isn't a plain session card, and his live/dead session lifecycle
 * shouldn't gate his presence here) — instead he gets his own permanent,
 * gold-framed `ArceusRosterCard`, pinned first, rendered unconditionally so
 * he's always here, even in a workspace with no sessions at all.
 */
export function RosterStrip({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(() => activeWorkspaceSessions.filter((s) => !s.isArceus), [activeWorkspaceSessions]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const battlers = useStore((s) => s.battlers);

  return (
    <div className="roster-strip">
      <ArceusRosterCard />
      {sessions.map((s) => (
        <Fragment key={s.id}>
          <AgentRosterCard session={s} selected={s.id === selectedId} onSelect={select} />
          {/* Subagent roster presence (Phase 4 Part B follow-up) — every live
              battler this session spawned gets its own card, immediately
              after its parent's, so it reads as belonging to it. */}
          {battlers
            .filter((b) => b.parentId === s.id)
            .map((b) => (
              <SubagentRosterCard key={b.key} battler={b} parent={s} />
            ))}
        </Fragment>
      ))}
      <button type="button" className="roster-strip-new" onClick={onNewSession}>
        + new agent
      </button>
    </div>
  );
}
