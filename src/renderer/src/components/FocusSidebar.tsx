import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { AgentRosterCard } from '@/components/AgentRosterCard';
import { SubagentRosterCard } from '@/components/SubagentRosterCard';
import { NewTerminalButton } from '@/components/NewTerminalButton';
import { DoubleChevronLeftIcon, DoubleChevronRightIcon } from '@/components/icons';

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
 *
 * "+ add agent" used to sit next to a second, separate "new terminal" icon
 * button — two adjacent "+" controls that read as redundant. They now merge
 * into one entry point: the dashed card opens a small menu offering "Claude
 * Code agent" (same `onNewSession` → NewSessionDialog as before) or
 * "Terminal" (same `NewTerminalButton` quick-start as before, now rendered as
 * a labeled menu item). Popover interaction follows AudioPopover.tsx's own
 * wrapper-ref + document-level outside-click/Escape dismissal pattern.
 *
 * Narrow-window support part 2 (issue #2 pt.2): below `NARROW_LAYOUT_MAX_PX`
 * (gardenSplit.ts) this sidebar's fixed 300px would leave xterm unusably
 * narrow, so index.css's `@media (max-width: 820px)` block collapses it to
 * hidden-by-default and turns it into a floating overlay ABOVE the terminal
 * panel (rather than a flex sibling that pushes/resizes it) once
 * `overlayOpen` below is toggled true via the edge tab. `overlayOpen` is
 * plain in-memory `useState` — no reason to persist "was the overlay open"
 * across launches, same call as `narrowLayout` (store.ts) itself — and needs
 * no reset when the window widens back out: the CSS driving both classes is
 * entirely scoped inside that `@media` block, so the class becomes inert
 * (normal fixed-sidebar layout reasserts) the instant the query stops
 * matching, regardless of this state's value. At normal widths the edge tab
 * is `display: none` and `.focus-sidebar` renders exactly as it always has.
 */
export function FocusSidebar({ onNewSession }: Props): JSX.Element {
  const activeWorkspaceSessions = useActiveWorkspaceSessions();
  const sessions = useMemo(() => activeWorkspaceSessions.filter((s) => !s.isArceus), [activeWorkspaceSessions]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const battlers = useStore((s) => s.battlers);
  const subagentCardsHidden = useStore((s) => s.subagentCardsHidden);
  const setSubagentCardsHidden = useStore((s) => s.setSubagentCardsHidden);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addMenuOpen]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !addMenuRef.current?.contains(event.target)) setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [addMenuOpen]);

  // Narrow-width overlay toggle — see the header comment above. Only ever
  // visible/interactive at narrow widths (index.css hides
  // `.focus-sidebar-edge-tab` outside the `@media` block), so this is a
  // no-op affordance at normal widths.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const edgeTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOverlayOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  useEffect(() => {
    if (!overlayOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !sidebarRef.current?.contains(event.target) &&
        !edgeTabRef.current?.contains(event.target)
      ) {
        setOverlayOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [overlayOpen]);

  return (
    <>
      <button
        type="button"
        ref={edgeTabRef}
        className="focus-sidebar-edge-tab tip"
        data-tip={overlayOpen ? 'hide agents' : 'show agents'}
        aria-label={overlayOpen ? 'hide agent roster' : 'show agent roster'}
        aria-pressed={overlayOpen}
        onClick={() => setOverlayOpen((v) => !v)}
      >
        {overlayOpen ? <DoubleChevronLeftIcon /> : <DoubleChevronRightIcon />}
      </button>
      <div ref={sidebarRef} className={overlayOpen ? 'focus-sidebar focus-sidebar-overlay-open' : 'focus-sidebar'}>
        <div className="focus-sidebar-add" ref={addMenuRef}>
          <button
            type="button"
            className="focus-sidebar-new"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            + add agent
          </button>
          {addMenuOpen && (
            <div className="focus-sidebar-add-menu" role="menu" aria-label="add agent">
              <button
                type="button"
                className="focus-sidebar-add-menu-item"
                role="menuitem"
                onClick={() => {
                  setAddMenuOpen(false);
                  onNewSession();
                }}
              >
                Claude Code agent
              </button>
              <NewTerminalButton
                className="focus-sidebar-add-menu-item"
                label="terminal"
                role="menuitem"
                onSelect={() => setAddMenuOpen(false)}
              />
            </div>
          )}
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
                  onSelect={(id) => {
                    select(id);
                    // Narrow-width overlay (see header comment) sits on top of the
                    // terminal — picking an agent from it should reveal what was
                    // just picked, not leave the roster covering it.
                    setOverlayOpen(false);
                  }}
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
    </>
  );
}
