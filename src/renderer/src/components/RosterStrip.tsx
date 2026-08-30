import { Fragment, useMemo } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { ArceusRosterCard } from '@/components/ArceusRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';
import { ARCEUS_SESSION_ID } from '@shared/arceus';

interface Props {
  onNewSession(): void;
}

/**
 * Bottom session strip (parity sweep item 5) — a horizontal-scroll row of
 * roster cards replacing the old top-chrome session chips + left sidebar,
 * used in 'garden' view mode only ('terminal' has its own vertical sidebar
 * instead, FocusSidebar.tsx; the two "Full" modes keep the previous topbar
 * chips — see App.tsx's own comment for why). "+ new agent" sits at the
 * strip's end, not in the top bar.
 *
 * Scoped to the ACTIVE workspace's sessions (Phase 8.7) — a session in
 * another workspace has no card here until you switch to it. Arceus is
 * global (`useActiveWorkspaceSessions` includes him regardless of which
 * workspace is active) and filtered out of the ordinary `sessions` list
 * below (he isn't a plain session card, and his live/dead session lifecycle
 * shouldn't gate his presence here) — instead he gets his own permanent,
 * gold-framed `ArceusRosterCard`, pinned first, rendered unconditionally so
 * he's always here, even in a workspace with no sessions at all.
 *
 * Garden-split roster-strip rework — cards are compact by default; the
 * currently SELECTED session's card expands to 'medium' (the approved
 * hybrid card, see AgentRosterCard.tsx and ArceusRosterCard.tsx). A subagent
 * never expands because it isn't independently selectable (clicking one
 * selects its parent instead). The strip itself is now wrapped in
 * `.roster-strip-wrap`, a non-scrolling
 * positioning context for the right-edge fade overlay (`.roster-strip-fade`)
 * that has to sit OUTSIDE the actual `overflow-x: auto` scroller below so it
 * stays pinned to the edge instead of scrolling away with the cards.
 */
export function RosterStrip({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(() => activeWorkspaceSessions.filter((s) => !s.isArceus), [activeWorkspaceSessions]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const battlers = useStore((s) => s.battlers);

  return (
    <div className="roster-strip-wrap">
      <div className="roster-strip">
        <ArceusRosterCard variant={selectedId === ARCEUS_SESSION_ID ? 'medium' : 'compact'} />
        {sessions.map((s) => (
          <Fragment key={s.id}>
            <AgentRosterCard
              session={s}
              selected={s.id === selectedId}
              onSelect={select}
              variant={s.id === selectedId ? 'medium' : 'compact'}
            />
            {/* Subagent roster presence (Phase 4 Part B follow-up) — every live
                battler this session spawned gets its own card, immediately
                after its parent's, so it reads as belonging to it. */}
            {battlers
              .filter((b) => b.parentId === s.id)
              .map((b) => (
                <SubagentRosterCard key={b.key} battler={b} parent={s} variant="compact" />
              ))}
          </Fragment>
        ))}
        <button type="button" className="roster-strip-new" onClick={onNewSession}>
          + new agent
        </button>
      </div>
      <div className="roster-strip-fade" aria-hidden="true" />
    </div>
  );
}
