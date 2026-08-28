import type { RefObject } from 'react';
import type { Session, ViewMode } from '@/store/store';
import { ArceusDispatchBox } from '@/components/ArceusDispatchBox';
import { FocusHeader } from '@/components/FocusHeader';
import { FocusComposer } from '@/components/FocusComposer';
import { FocusTerminalHead } from '@/components/FocusTerminalHead';
import { TerminalFindBar } from '@/components/TerminalFindBar';
import { stopSession } from '@/sessions';
import { sessionStatusLabel } from '@/design/sessionLabel';

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
 * framed `.terminal-panel` with its own mini header (FocusTerminalHead —
 * live indicator + font-size stepper). That wrapper and its head are BOTH
 * unconditional too, same reasoning as above — only their className/content
 * vary with `focus`, never their presence in the tree, so the `mountRef` div
 * they wrap never sees a different ancestor shape across a viewMode toggle.
 *
 * 'terminal' view mode (BACKLOG phase E) is the per-agent command center:
 * FocusHeader above the terminal, FocusComposer (or Arceus's own dispatch
 * box — never both, see the trailing block) below it. Every other mode
 * keeps the pre-phase-E drawer-meta / dispatch-box-above-terminal layout,
 * unchanged.
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
      {focus ? (
        <FocusHeader session={session} />
      ) : (
        <div className="drawer-meta">
          <span className={session.napping ? 'status napping' : `status ${session.status}`}>
            {sessionStatusLabel(session)}
          </span>
          <span className="path" title={session.cwd}>
            {session.cwd}
          </span>
          <button className="danger" onClick={() => void stopSession(session.id)}>
            kill
          </button>
        </div>
      )}

      {session.error && <p className="error drawer-error">{session.error}</p>}

      {/* Garden/gardenFull mode keeps Arceus's dispatch box ABOVE the
          terminal (Phase 8.8 §6, unchanged); focus mode moves it below, into
          the composer's own slot — see the trailing block. */}
      {!focus && session.isArceus && <ArceusDispatchBox sessionId={session.id} />}

      <div className={focus ? 'terminal-panel terminal-panel-focus' : 'terminal-panel'}>
        <FocusTerminalHead label={session.title} />
        <div className="terminal-mount-wrap">
          <div className="terminal-mount" ref={mountRef} />
          {findOpen && <TerminalFindBar sessionId={session.id} onClose={onCloseFind} />}
        </div>
      </div>

      {focus &&
        (session.isArceus ? (
          <ArceusDispatchBox sessionId={session.id} />
        ) : (
          <FocusComposer session={session} />
        ))}
    </>
  );
}
