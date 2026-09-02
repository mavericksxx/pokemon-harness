import { useEffect } from 'react';
import {
  arceus,
  berry,
  closeDemoConsole,
  closingRitual,
  done,
  evolve,
  exitDemo,
  idle,
  looping,
  mega,
  nap,
  needsYou,
  recall,
  shiny,
  showreel,
  smallTalk,
  spawn,
  subagent,
  subagentDone,
  thinking,
  toast,
  toggleDemoConsole,
  toolCall,
  useDemoConsoleOpen,
  useShowreelRunning
} from '@/demo';

/** Topbar "demo" chip + trigger popover (in-app demo mode) — same anchored-
 *  popover pattern as QuickSettings.tsx (`.quick-settings-panel`, a full-
 *  screen catcher for outside-click, Escape closes). Every button here drives
 *  the REAL garden/roster/terminal through demo.ts's mock-session layer; none
 *  of it touches a real pty. Open/closed state lives in demo.ts (not local
 *  `useState`) so App.tsx's global ⌘D shortcut can toggle it too. */
export function DemoConsole(): JSX.Element {
  const open = useDemoConsoleOpen();
  const showreelRunning = useShowreelRunning();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDemoConsole();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="demo-console">
      <button
        type="button"
        className="summon-arceus demo-chip tip"
        data-tip="demo console (⌘D)"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => toggleDemoConsole()}
      >
        <span className="summon-arceus-glyph" aria-hidden="true">
          ▸
        </span>
        demo
      </button>

      {open && (
        <>
          <div className="quick-settings-catcher" onClick={() => closeDemoConsole()} />
          <div className="demo-console-panel" role="dialog" aria-label="demo console">
            <h3 className="demo-console-title">demo console</h3>
            <p className="hint demo-console-hint">mock sessions — nothing is spawned</p>

            <div className="demo-console-grid">
              <button type="button" onClick={() => void showreel()}>
                {showreelRunning ? 'stop showreel' : 'showreel'}
              </button>
              <button type="button" onClick={() => spawn()}>
                spawn
              </button>
              <button type="button" onClick={() => shiny()}>
                shiny
              </button>
              <button type="button" onClick={() => subagent()}>
                subagent
              </button>
              <button type="button" onClick={() => subagentDone()}>
                subagent done
              </button>
              <button type="button" onClick={() => mega()}>
                mega battle
              </button>
              <button type="button" onClick={() => toolCall()}>
                tool call
              </button>
              <button type="button" onClick={() => thinking()}>
                thinking
              </button>
              <button type="button" onClick={() => idle()}>
                idle
              </button>
              <button type="button" onClick={() => needsYou()}>
                needs you
              </button>
              <button type="button" onClick={() => done()}>
                done
              </button>
              <button type="button" onClick={() => recall()}>
                recall
              </button>
              <button type="button" onClick={() => nap()}>
                nap
              </button>
              <button type="button" onClick={() => looping()}>
                looping
              </button>
              <button type="button" onClick={() => smallTalk()}>
                small talk
              </button>
              <button type="button" onClick={() => berry()}>
                berry
              </button>
              <button type="button" onClick={() => evolve()}>
                evolve
              </button>
              <button type="button" onClick={() => arceus()}>
                arceus
              </button>
              <button type="button" onClick={() => closingRitual()}>
                closing ritual
              </button>
              <button type="button" onClick={() => toast()}>
                toast
              </button>
            </div>

            <button type="button" className="danger demo-console-exit" onClick={() => exitDemo()}>
              exit demo
            </button>
          </div>
        </>
      )}
    </div>
  );
}
