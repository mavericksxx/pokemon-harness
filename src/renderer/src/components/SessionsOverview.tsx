import { Fragment } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';

/** Full-roster grid (Phase 8 §3/§7) — opened from the topbar button or the
 *  garden's signpost prop. Picking a card selects that session and switches
 *  to terminal-focus so the pick has somewhere to land.
 *
 *  Scoped to the ACTIVE workspace's sessions (Phase 8.7) — same reasoning
 *  as RosterStrip. Arceus is excluded here too, same reasoning as RosterStrip
 *  — his topbar chip is his one home. */
export function SessionsOverview(): JSX.Element | null {
  const open = useStore((s) => s.sessionsOverviewOpen);
  const setOpen = useStore((s) => s.setSessionsOverviewOpen);
  const sessions = useActiveWorkspaceSessions().filter((s) => !s.isArceus);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);
  const battlers = useStore((s) => s.battlers);

  if (!open) return null;

  const pick = (id: string): void => {
    select(id);
    setViewMode('terminal');
    setOpen(false);
  };

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal sessions-overview" onClick={(e) => e.stopPropagation()}>
        <h2>sessions</h2>
        {sessions.length === 0 ? (
          <p className="empty">no sessions in this workspace yet — start one from the topbar.</p>
        ) : (
          <div className="sessions-overview-grid">
            {sessions.map((s) => (
              <Fragment key={s.id}>
                <AgentRosterCard session={s} selected={s.id === selectedId} onSelect={pick} />
                {/* Subagent roster presence (Phase 4 Part B follow-up), same
                    pattern as RosterStrip — every live battler this session
                    spawned gets its own card grouped with its parent's.
                    `onNavigate` closes this overlay the same way `pick`
                    does for a parent card's own click. */}
                {battlers
                  .filter((b) => b.parentId === s.id)
                  .map((b) => (
                    <SubagentRosterCard key={b.key} battler={b} parent={s} onNavigate={() => setOpen(false)} />
                  ))}
              </Fragment>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={() => setOpen(false)}>close</button>
        </div>
      </div>
    </div>
  );
}
