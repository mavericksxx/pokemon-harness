import { Fragment, useMemo, useState } from 'react';
import { useStore, type Session } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { ArceusRosterCard } from '@/components/ArceusRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';
import { DoubleChevronLeftIcon, DoubleChevronRightIcon } from '@/components/icons';

interface Props {
  onNewSession(): void;
}

/** Applies the rail's manual drag order (store.ts's `partyRailOrder`) to a
 *  list of live sessions: a session whose id appears in `order` sorts by its
 *  index there; one that doesn't (e.g. a session just created, never
 *  dragged) sorts to the end, after every ordered session, keeping its place
 *  relative to other not-yet-ordered sessions via the sort's stability. */
function applyPartyRailOrder(sessions: Session[], order: string[]): Session[] {
  const indexById = new Map(order.map((id, i) => [id, i]));
  return [...sessions].sort((a, b) => {
    const ai = indexById.get(a.id) ?? Infinity;
    const bi = indexById.get(b.id) ?? Infinity;
    return ai - bi;
  });
}

/**
 * The party rail — a 200px fixed-width vertical rail on the LEFT of
 * `.body-row`, mounted in 'garden' and 'terminal' view modes (App.tsx's own
 * `showRosterRail`) — NOT 'gardenFull', whose ViewModeSwitcher entry is
 * explicitly labelled "garden only — no chrome"; a permanent rail there
 * would be exactly the chrome that mode exists to shed. That leaves
 * gardenFull with no roster surface and no Arceus card at all — deliberate,
 * not a gap: ⌘1/⌘2 is the way back to a mode where either is reachable.
 *
 * Replaces two things that each used to own a slice of session-switching UI
 * in the two modes THIS component actually mounts in: this component's own
 * former horizontal `.roster-strip` band ('garden' only) and the separate
 * vertical sidebar `FocusSidebar.tsx` used to own ('terminal' only, now
 * retired) — one roster UI for both instead of two different ones. The
 * topbar's `OverflowChipRow` session chips (App.tsx, 'gardenFull' only) are
 * simply retired, with nothing replacing them in that mode.
 *
 * Structure, top to bottom: a header (active garden's name + live/total
 * counts), a scrolling list (Arceus pinned first with no heading, then an
 * "agents" section), and a footer holding "+ new agent".
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
 * Card anatomy — every ordinary card (selected or not) now always shows all
 * three of `AgentRosterCard`'s `variant="medium"` rows (face+title+dot,
 * provider·species, model+context); the old 'compact' variant (which
 * dropped rows 2/3 for every unselected card) is retired along with it, so
 * only 'medium'/'full' remain meaningful for that component now. Selection
 * is a border/glow only (`.roster-card.selected`), not a size change — the
 * rail's fixed 200px width doesn't have room to grow a card on select the
 * way the old horizontal strip did. Subagent cards keep their existing
 * `variant="compact"` (drops the model/context row — there's no real
 * per-subagent telemetry to show, see SubagentRosterCard.tsx) and render
 * indented under their parent with a mint left border (`.party-rail-child`).
 *
 * Subagent disclosure is now PER-PARENT (`collapsedParentIds`, store.ts)
 * instead of the old single global `subagentCardsHidden` toggle that drew
 * the same state twice (a toggle button pinned outside the scroller, plus a
 * "hidden count" badge on the parent card) — `AgentRosterCard`'s own small
 * `▾ n`/`▸ n` disclosure control now carries just its own parent's count.
 * ⌥-click on any disclosure collapses/expands every parent at once,
 * preserving the old global behavior as a modifier instead of a permanent
 * separate control.
 *
 * First-class delegate sessions (`delegateParentId`, spawned via
 * poke-delegate) nest under their parent through this exact same path,
 * counted alongside battlers in the disclosure's `n` and hidden/shown by the
 * same collapse toggle — never a top-level card of their own, live or done.
 * A done one keeps sitting there (its walker keeps wandering the garden too,
 * see GardenScene.tsx) until the user hits its own despawn control, same as
 * a done subagent battler.
 *
 * Below ~1100px viewport (index.css) the rail collapses to a 56px column of
 * face tiles — titles move into each card's own `title` tooltip, the
 * header's text hides, and the footer becomes a bare "+" tile. Pure CSS
 * (a plain `@media` query) — see gardenSplit.ts's `PARTY_RAIL_PX` for why
 * `NARROW_LAYOUT_MAX_PX` had to learn about this rail's width too. The
 * header's own chevron button below drives the exact same 56px treatment
 * manually (`store.ts`'s persisted `railCollapsed`), independent of viewport
 * width — see index.css's "Collapsed rail" section for both triggers.
 */
export function RosterStrip({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(() => activeWorkspaceSessions.filter((s) => !s.isArceus), [activeWorkspaceSessions]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const battlers = useStore((s) => s.battlers);
  const collapsedParentIds = useStore((s) => s.collapsedParentIds);
  const toggleParentCollapsed = useStore((s) => s.toggleParentCollapsed);
  const toggleAllParentsCollapsed = useStore((s) => s.toggleAllParentsCollapsed);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const setRailCollapsed = useStore((s) => s.setRailCollapsed);
  const partyRailOrder = useStore((s) => s.partyRailOrder);
  const setPartyRailOrder = useStore((s) => s.setPartyRailOrder);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // Top-level card drag-to-reorder (party-rail rework) — only the "agents"
  // section's cards are draggable (see `renderSession`), never Arceus, a
  // subagent card, or a delegate card (the latter two only ever render
  // nested under their parent, below).
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const activeWorkspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? workspaces[0]?.name ?? '';

  // First-class delegate sessions never get a top-level card of their own —
  // like a subagent battler, a delegate's card only ever renders nested
  // under its parent (`renderSession`'s own `sessionDelegates` below), live
  // or done alike.
  const topLevelSessions = sessions.filter((s) => !s.delegateParentId);

  // Display order only — never the underlying `sessions` array itself (that
  // stays in ordinary session-creation order for every other consumer, e.g.
  // SessionsOverview's grid). Recomputed whenever `topLevelSessions` or the
  // persisted order changes.
  const orderedTopLevelSessions = useMemo(
    () => applyPartyRailOrder(topLevelSessions, partyRailOrder),
    [topLevelSessions, partyRailOrder]
  );

  const workingCount = sessions.filter((s) => s.status === 'working').length;

  // All parent ids with at least one live battler or delegate right now —
  // the scope ⌥-click's "collapse/expand everything" applies to.
  const parentIdsWithChildren = sessions
    .filter((s) => battlers.some((b) => b.parentId === s.id) || sessions.some((d) => d.delegateParentId === s.id))
    .map((s) => s.id);

  const renderSession = (s: Session): JSX.Element => {
    const sessionBattlers = battlers.filter((b) => b.parentId === s.id);
    const sessionDelegates = sessions.filter((d) => d.delegateParentId === s.id);
    const collapsed = collapsedParentIds.includes(s.id);
    const dragClasses = [s.id === draggedId ? 'dragging' : '', s.id === dragOverId ? 'drag-over' : '']
      .filter(Boolean)
      .join(' ');
    return (
      <Fragment key={s.id}>
        {/* Wraps AgentRosterCard rather than passing it drag props directly
            — it doesn't accept arbitrary DOM props, and its own `memo()`/
            styling assumptions shouldn't need to know about drag-to-reorder
            at all. */}
        <div
          className={dragClasses || undefined}
          draggable
          onDragStart={() => setDraggedId(s.id)}
          onDragOver={(e) => {
            if (!draggedId || draggedId === s.id) return;
            e.preventDefault();
            setDragOverId(s.id);
          }}
          onDragLeave={() => setDragOverId((cur) => (cur === s.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            if (!draggedId || draggedId === s.id) {
              setDraggedId(null);
              setDragOverId(null);
              return;
            }
            const ids = orderedTopLevelSessions.map((sess) => sess.id);
            const fromIdx = ids.indexOf(draggedId);
            const toIdx = ids.indexOf(s.id);
            if (fromIdx !== -1 && toIdx !== -1) {
              const next = [...ids];
              next.splice(fromIdx, 1);
              next.splice(toIdx, 0, draggedId);
              setPartyRailOrder(next);
            }
            setDraggedId(null);
            setDragOverId(null);
          }}
          onDragEnd={() => {
            setDraggedId(null);
            setDragOverId(null);
          }}
        >
          <AgentRosterCard
            session={s}
            selected={s.id === selectedId}
            onSelect={select}
            variant="medium"
            childCount={sessionBattlers.length + sessionDelegates.length}
            collapsed={collapsed}
            onToggleCollapse={(altKey) =>
              altKey ? toggleAllParentsCollapsed(parentIdsWithChildren) : toggleParentCollapsed(s.id)
            }
          />
        </div>
        {!collapsed && (
          <>
            {sessionBattlers.map((b) => (
              <div key={b.key} className="party-rail-child">
                <SubagentRosterCard battler={b} parent={s} variant="compact" />
              </div>
            ))}
            {sessionDelegates.map((d) => (
              <div key={d.id} className="party-rail-child">
                <AgentRosterCard session={d} selected={d.id === selectedId} onSelect={select} variant="medium" />
              </div>
            ))}
          </>
        )}
      </Fragment>
    );
  };

  return (
    <div className={`party-rail${railCollapsed ? ' rail-collapsed' : ''}`}>
      <div className="party-rail-header">
        <span className="party-rail-garden-name">{activeWorkspaceName}</span>
        <span className="party-rail-counts">
          {sessions.length} · {workingCount} working
        </span>
        {/* Manual collapse toggle — same double-chevron "collapse/expand this
            direction" glyph as the topbar's hide/show-terminal button
            (App.tsx), same level-2 ghost icon-button weight. Collapsing
            drives the rail to the same 56px icon-only treatment the
            `@media (max-width: 1100px)` breakpoint already applies
            (index.css's "Collapsed rail" section) — one visual state, two
            triggers. */}
        <button
          type="button"
          className="party-rail-collapse-btn tip"
          data-tip={railCollapsed ? 'expand agents' : 'collapse agents'}
          aria-label={railCollapsed ? 'expand agents' : 'collapse agents'}
          aria-expanded={!railCollapsed}
          onClick={() => setRailCollapsed(!railCollapsed)}
        >
          {railCollapsed ? <DoubleChevronRightIcon /> : <DoubleChevronLeftIcon />}
        </button>
      </div>
      <div className="party-rail-list">
        {/* Arceus is global, not scoped to any one garden, so he's pinned
            first with no section heading of his own. His card always reads
            as distinctly ceremonial (not just another row) — 'medium' and
            `ceremonial` regardless of view mode or selection, so he looks
            identical in the garden+terminal split as he does in full
            terminal view; the rail is the one place he reads as the
            garden's god rather than an ordinary agent. */}
        <ArceusRosterCard variant="medium" ceremonial />
        {topLevelSessions.length > 0 && <div className="party-rail-heading">agents</div>}
        {orderedTopLevelSessions.map((s) => renderSession(s))}
      </div>
      <button type="button" className="party-rail-new" onClick={onNewSession}>
        <span className="party-rail-new-label">+ new agent</span>
        <span className="party-rail-new-icon" aria-hidden="true">
          +
        </span>
      </button>
    </div>
  );
}
