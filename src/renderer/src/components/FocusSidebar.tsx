import { Fragment, useMemo } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';
import { NewTerminalButton } from '@/components/NewTerminalButton';

interface Props {
  onNewSession(): void;
}

/**
 * Munder Difflin restyle — 'terminal' view mode's own left sidebar roster,
 * replacing the bottom RosterStrip.tsx for that mode only ('garden' keeps
 * the horizontal strip unchanged; see App.tsx). Same session-switching
 * affordance and the same AgentRosterCard used everywhere else — this is a
 * placement/orientation change, not a new card — just top-anchored "+ add
 * agent" and a vertical, full-height list instead of a horizontal scroll
 * row. index.css's `.focus-sidebar` rules undo the horizontal strip's
 * stretch-height behavior so rows size to their own content.
 *
 * Scoped to the ACTIVE workspace's sessions (Phase 8.7), same filter as
 * RosterStrip — Arceus excluded (his one home is the topbar chip).
 *
 * Honors the same GLOBAL `subagentCardsHidden` toggle as RosterStrip.tsx
 * (store.ts), with a local control so the terminal view remains self-contained
 * when it is shown without the garden roster strip.
 */
export function FocusSidebar({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(() => activeWorkspaceSessions.filter((s) => !s.isArceus), [activeWorkspaceSessions]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const battlers = useStore((s) => s.battlers);
  const subagentCardsHidden = useStore((s) => s.subagentCardsHidden);
  const setSubagentCardsHidden = useStore((s) => s.setSubagentCardsHidden);

  return (
    <div className="focus-sidebar">
      <div className="focus-sidebar-actions">
        <button type="button" className="focus-sidebar-new" onClick={onNewSession}>
          + add agent
        </button>
        <NewTerminalButton className="focus-sidebar-terminal" />
      </div>
      <button
        type="button"
        className={subagentCardsHidden ? 'focus-sidebar-toggle tip active' : 'focus-sidebar-toggle tip'}
        onClick={() => setSubagentCardsHidden(!subagentCardsHidden)}
        aria-pressed={subagentCardsHidden}
        aria-label={subagentCardsHidden ? 'show subagent cards' : 'hide subagent cards'}
        data-tip={subagentCardsHidden ? 'show subagents' : 'hide subagents'}
      >
        {subagentCardsHidden ? '▸' : '▾'} subagents
      </button>
      <div className="focus-sidebar-list">
        {sessions.map((s) => {
          const sessionBattlers = battlers.filter((b) => b.parentId === s.id);
          return (
            <Fragment key={s.id}>
              <AgentRosterCard
                session={s}
                selected={s.id === selectedId}
                onSelect={select}
                hiddenSubagentCount={subagentCardsHidden && sessionBattlers.length > 0 ? sessionBattlers.length : undefined}
              />
              {/* Subagent roster presence (Phase 4 Part B follow-up), same
                  pattern as RosterStrip — every live battler this session
                  spawned gets its own card right after its parent's. Skipped
                  while `subagentCardsHidden` is set — the parent's own badge
                  shows the count instead. */}
              {!subagentCardsHidden &&
                sessionBattlers.map((b) => <SubagentRosterCard key={b.key} battler={b} parent={s} />)}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
