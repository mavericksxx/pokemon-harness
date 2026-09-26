import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useActiveWorkspaceSessions } from '@/store/workspaceScope';
import { useExternalSessionsStore } from '@/store/externalSessionsStore';
import type { ExternalSessionSummary } from '@shared/externalSessions';
import { attachTerminal, detachTerminal, focusTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { FocusView } from '@/components/FocusView';
import { NewTerminalButton } from '@/components/NewTerminalButton';
import { TranscriptView } from '@/components/TranscriptView';
import { terminalWidthCss } from '@/gardenSplit';
import { useEffectiveLayout } from '@/effectiveLayout';

interface Props {
  /** Continue-mode entry point (docs/external-sessions-plan.md §7 step 3) —
   *  called with the row TranscriptView's "Continue session" button was
   *  clicked for. App.tsx owns the new-agent dialog's continue-target state,
   *  so this is the callback that hands it that row. */
  onContinueExternal(session: ExternalSessionSummary): void;
}

/** Side panel showing the SELECTED session's terminal. Only one terminal is
 *  mounted at a time — see terminalRegistry for why (WebGL context budget).
 *
 *  The tab strip (`.drawer-tabs`) is scoped to the ACTIVE workspace's
 *  sessions (Phase 8.7); the currently-open terminal itself is looked up
 *  against the FULL session list (`selectedSession`, below) rather than the
 *  scoped one, so a `selectedId` that's momentarily out of sync with the
 *  active workspace (there shouldn't be one — the workspace switch itself
 *  re-points selection — but this is the cheap belt-and-braces read) still
 *  resolves instead of silently rendering the empty state.
 *
 *  `selectedSession` selects only the one session this component actually
 *  reads (not the whole `s.sessions` array — that would re-render this
 *  drawer on every OTHER session's tick too) — its identity only changes
 *  when the selected session itself changes, or a genuine patch lands on it
 *  (see store.ts's `updateSession` no-op guard). */
export function TerminalDrawer({ onContinueExternal }: Props): JSX.Element | null {
  const selectedSession = useStore((s) => s.sessions.find((x) => x.id === s.selectedId) ?? undefined);
  // Read-only chat preview (§7 step 3) — when set, this drawer shows
  // TranscriptView in place of the ordinary tab strip + FocusView terminal,
  // regardless of view mode (see the early return in the JSX below).
  const previewExternalId = useExternalSessionsStore((s) => s.previewExternalId);
  const previewSessions = useExternalSessionsStore((s) => s.sessions);
  const setPreviewExternalId = useExternalSessionsStore((s) => s.setPreviewExternalId);
  const previewSession = previewSessions.find((s) => s.id === previewExternalId);
  const sessions = useActiveWorkspaceSessions();
  const selectedId = useStore((s) => s.selectedId);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const gardenSplit = useStore((s) => s.gardenSplit);
  const select = useStore((s) => s.select);
  const viewMode = useStore((s) => s.viewMode);
  // A completed first-class delegate remains in the session store for its
  // roster card, but its terminal tab is closed as soon as its PTY exits.
  // Arceus is excluded too, same reasoning as SessionsOverview.tsx — he's
  // global (`useActiveWorkspaceSessions` includes him in every workspace)
  // and reachable from his own pinned rail card instead, not this tab strip.
  // `selectedSession`/`open` below don't read `tabSessions`, so selecting
  // his rail card still opens his terminal in 'terminal' mode even though
  // the strip shows no active tab for it — intended, not a bug. (In
  // 'garden' mode `open` is never true for him at all — see `drawerVisible`
  // below.)
  const tabSessions = sessions.filter((s) => !s.isArceus && !(s.delegateParentId && s.status === 'done'));
  const mountRef = useRef<HTMLDivElement>(null);
  // Find-in-scrollback (item 3 §1) — closed whenever the selected session
  // changes, so switching tabs never leaves a stale find bar (and its
  // highlights, scoped to the PREVIOUS session's terminal) hanging around.
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => setFindOpen(false), [selectedId]);

  // Phase 8 §1: 'terminal' always shows the terminal (it IS the view);
  // 'gardenFull' never does; 'garden' keeps the old manual toggle — EXCEPT
  // for Arceus, whose Hall of Origin HUD already shows everything the
  // drawer would, so 'garden' mode never opens it for him regardless of the
  // shared `drawerOpen` preference's value. effectiveLayout.ts is the one
  // shared place this (and `wide`, below) is computed — App.tsx and
  // GardenScene.tsx read the same thing, so this can't drift from what
  // actually gets laid out.
  const { drawerWide: wide, drawerVisible: open } = useEffectiveLayout();
  // The bottom roster strip (terminal-focus mode; parity sweep item 5,
  // formerly a left sidebar) already offers session switching; the drawer's
  // own tab strip would just duplicate it.
  const showTabs = viewMode !== 'terminal';

  useEffect(() => {
    const el = mountRef.current;
    if (!open || !el || !selectedId || !hasTerminal(selectedId)) return;
    attachTerminal(selectedId, el);
    focusTerminal(selectedId);
    return () => detachTerminal(selectedId);
    // Deliberately NOT keyed on the session list: re-attaching on every
    // spawn/kill would churn the terminal's WebGL context for no reason.
  }, [open, selectedId]);

  // If the selected delegate is the one that just completed, move focus to
  // its parent (or the next remaining tab) so the drawer closes that dead
  // terminal instead of merely hiding its tab while still displaying it.
  useEffect(() => {
    if (!selectedId) return;
    if (!selectedSession?.delegateParentId || selectedSession.status !== 'done') return;
    const next =
      tabSessions.find((s) => s.id === selectedSession.delegateParentId) ??
      tabSessions.find((s) => s.id !== selectedId);
    select(next?.id ?? null);
  }, [selectedSession, selectedId, tabSessions, select]);

  // Cmd/Ctrl+F opens the find bar instead of the OS/browser's own find —
  // only while a terminal is actually mounted here.
  useEffect(() => {
    if (!open || !selectedId) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, selectedId]);

  // The draggable split (GardenSplitHandle.tsx) only applies to the
  // side-by-side 'garden' layout — `wide` mode fills the row on its own via
  // `.drawer-wide`'s `flex: 1`, no width of its own to override.
  const splitStyle = wide ? undefined : { width: terminalWidthCss(gardenSplit) };

  // Read-only chat preview (§7 step 3, fixed 2026-09-26 review D2) — rendered
  // as an OVERLAY on top of the ordinary tab strip + FocusView terminal,
  // never in place of them. The earlier version swapped the whole `<aside>`
  // subtree, unmounting FocusView's `mountRef` div; the attach effect above
  // is keyed on `[open, selectedId]` only, so nothing re-fired to reattach
  // xterm once that div came back — Continue and closing the preview with ×
  // both left a blank terminal. Keeping FocusView permanently mounted
  // (same reasoning as its own header comment: one stable component
  // instance, never swapped) means the terminal is simply never detached in
  // the first place, so there's nothing to reattach.
  const showPreview = !!previewSession;
  if (!open && !showPreview) return null;

  const session = selectedSession;

  return (
    <aside className={wide ? 'drawer drawer-wide' : 'drawer'} style={splitStyle}>
      {open && showTabs && (
        <header className="drawer-head">
          <div className="drawer-tabs">
            {tabSessions.map((s) => (
              <button
                key={s.id}
                className={s.id === selectedId ? 'tab active' : 'tab'}
                onClick={() => select(s.id)}
                style={{ borderBottomColor: `#${s.accent.toString(16).padStart(6, '0')}` }}
              >
                {s.title}
              </button>
            ))}
            <NewTerminalButton className="drawer-tab-new" />
          </div>
          {viewMode === 'garden' && (
            <button className="icon tip" data-tip="hide terminal" onClick={() => setDrawerOpen(false)}>
              ×
            </button>
          )}
        </header>
      )}

      {open && (
        /* FocusView.tsx owns everything below the tabs header for EVERY view
           mode (BACKLOG phase E) — see its own header for why TerminalDrawer
           must always render exactly this one component, never switch
           between two, so the `mountRef` div it renders keeps its identity
           (and therefore every session's terminal/scrollback) across a
           viewMode toggle, AND across the preview overlay above (D2). */
        <FocusView
          session={session}
          viewMode={viewMode}
          mountRef={mountRef}
          findOpen={findOpen}
          onCloseFind={() => setFindOpen(false)}
        />
      )}

      {showPreview && previewSession && (
        <div className="transcript-view-overlay">
          <TranscriptView
            session={previewSession}
            onClose={() => setPreviewExternalId(null)}
            onContinue={() => onContinueExternal(previewSession)}
          />
        </div>
      )}
    </aside>
  );
}
