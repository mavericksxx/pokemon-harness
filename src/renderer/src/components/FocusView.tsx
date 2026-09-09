import type { RefObject } from 'react';
import type { Session, ViewMode } from '@/store/store';
import { ArceusDispatchBox } from '@/components/ArceusDispatchBox';
import { FocusHeader } from '@/components/FocusHeader';
import { SessionStatusStrip } from '@/components/SessionStatusStrip';
import { TerminalFindBar } from '@/components/TerminalFindBar';
import { restartSessionFresh } from '@/sessions';

interface Props {
  session: Session | undefined;
  viewMode: ViewMode;
  mountRef: RefObject<HTMLDivElement>;
  findOpen: boolean;
  onCloseFind: () => void;
}

/**
 * The terminal-owning portion of TerminalDrawer.tsx's `<aside>` — TerminalDrawer
 * renders exactly ONE of these regardless of view mode (the tabs header above
 * it is the only other conditional piece, and it's a sibling, not an
 * ancestor of this). That's deliberate, not incidental: the `mountRef` div
 * below is where terminalRegistry.ts's attach/detach effect (TerminalDrawer's
 * own `useEffect`, keyed on `[open, selectedId]` only — never `viewMode`)
 * physically re-parents a session's xterm host. If this component's TYPE
 * ever differed across a viewMode toggle (e.g. TerminalDrawer choosing
 * between two different components via a ternary), React would unmount and
 * remount this whole subtree on every mode switch, tearing that div out of
 * the document without the attach effect re-running to reattach it —
 * leaving a session's terminal blank until its `selectedId` happened to
 * change too. One stable component instance, with only its header/composer
 * CHILDREN branching on `viewMode`, keeps the mount point's identity — and
 * every session's scrollback (held entirely in terminalRegistry.ts, outside
 * React) — untouched by a mode switch.
 *
 * Munder Difflin restyle (backlog item): the terminal now sits inside a
 * framed `.terminal-panel`, with `SessionStatusStrip` (the bottom statusline
 * — status chip, model, context, multitask, cwd, kill) below the mount. That
 * wrapper and the strip are BOTH unconditional too, same reasoning as
 * above — only their className/content vary with `focus`, never their
 * presence in the tree, so the `mountRef` div they wrap never sees a
 * different ancestor shape across a viewMode toggle.
 *
 * 'terminal' view mode (BACKLOG phase E) is the per-agent command center:
 * FocusHeader above the terminal, Arceus's own dispatch box below it (see
 * the trailing block) when he's selected. Every other mode keeps the
 * pre-phase-E dispatch-box-above-terminal layout, unchanged (its old
 * `.drawer-meta` status/cwd/kill row moved into `SessionStatusStrip` below
 * the terminal instead).
 *
 * Parity sweep item 8 — the "queue" composer that used to sit below the
 * terminal in focus mode for every non-Arceus session is gone entirely (user
 * report: it wasted vertical space the terminal itself could use — the CLI
 * already queues typed input on its own). `.terminal-panel`'s existing
 * `flex: 1` means the terminal simply expands into the reclaimed space with
 * no CSS change needed. Arceus's dispatch box (ArceusDispatchBox.tsx) is a
 * wholly different component — writes straight into his pty — and is
 * untouched.
 */
export function FocusView({ session, viewMode, mountRef, findOpen, onCloseFind }: Props): JSX.Element {
  const focus = viewMode === 'terminal';

  if (!session) {
    return (
      <div className="empty-terminal">
        <div className="empty-terminal-glyph" aria-hidden="true" />
        <p className="empty">{focus ? 'select an agent below.' : "pick a session to see what's happening."}</p>
      </div>
    );
  }

  return (
    <>
      {focus && <FocusHeader session={session} />}

      {session.error && (
        <p className="error drawer-error">
          {session.error}
          {/* Recovery for a failed `claude --resume` at launch (sessionRespawn.ts) —
              the app already fell back to a plain shell under this same card, so
              this just replaces it with a genuinely fresh (non-resume) session
              instead of leaving the banner stuck here forever. */}
          <button className="toast-action" onClick={() => void restartSessionFresh(session.id)}>
            start fresh here
          </button>
        </p>
      )}

      {/* Garden/gardenFull mode keeps Arceus's dispatch box ABOVE the
          terminal (Phase 8.8 §6, unchanged); focus mode moves it below, into
          the composer's own slot — see the trailing block. */}
      {!focus && session.isArceus && <ArceusDispatchBox sessionId={session.id} />}

      <div className={focus ? 'terminal-panel terminal-panel-focus' : 'terminal-panel'}>
        <div className="terminal-mount-wrap">
          <div className="terminal-mount" ref={mountRef} />
          {findOpen && <TerminalFindBar sessionId={session.id} onClose={onCloseFind} />}
        </div>
        <SessionStatusStrip session={session} />
      </div>

      {focus && session.isArceus && <ArceusDispatchBox sessionId={session.id} />}
    </>
  );
}
