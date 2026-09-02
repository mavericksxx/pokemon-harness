import { useEffect } from 'react';
import {
  arceus,
  berry,
  cancelShowreel,
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
  useDemoActive,
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
  const active = useDemoActive();
  const showreelRunning = useShowreelRunning();

  const fire = (trigger: () => void): void => {
    trigger();
    closeDemoConsole();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDemoConsole();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!active) return <div className="demo-console" />;

  return (
    <div className="demo-console">
      <button
        type="button"
        className="summon-arceus demo-chip tip"
        data-tip={showreelRunning ? 'stop showreel' : 'demo console (⌘D)'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (showreelRunning ? fire(cancelShowreel) : toggleDemoConsole())}
      >
        <span className="summon-arceus-glyph" aria-hidden="true">
          ▸
        </span>
        {showreelRunning ? 'stop showreel' : 'demo'}
      </button>

      {open && (
        <div className="demo-console-panel" role="dialog" aria-label="demo console">
            <h3 className="demo-console-title">demo console</h3>
            <p className="hint demo-console-hint">mock sessions — nothing is spawned</p>

            <div className="demo-console-grid">
              <button type="button" onClick={() => fire(() => void showreel())}>
                showreel
              </button>
              <button type="button" onClick={() => fire(spawn)}>
                spawn
              </button>
              <button type="button" onClick={() => fire(shiny)}>
                shiny
              </button>
              <button type="button" onClick={() => fire(subagent)}>
                subagent
              </button>
              <button type="button" onClick={() => fire(subagentDone)}>
                subagent done
              </button>
              <button type="button" onClick={() => fire(mega)}>
                mega battle
              </button>
              <button type="button" onClick={() => fire(toolCall)}>
                tool call
              </button>
              <button type="button" onClick={() => fire(thinking)}>
                thinking
              </button>
              <button type="button" onClick={() => fire(idle)}>
                idle
              </button>
              <button type="button" onClick={() => fire(needsYou)}>
                needs you
              </button>
              <button type="button" onClick={() => fire(done)}>
                done
              </button>
              <button type="button" onClick={() => fire(recall)}>
                recall
              </button>
              <button type="button" onClick={() => fire(nap)}>
                nap
              </button>
              <button type="button" onClick={() => fire(looping)}>
                looping
              </button>
              <button type="button" onClick={() => fire(smallTalk)}>
                small talk
              </button>
              <button type="button" onClick={() => fire(berry)}>
                berry
              </button>
              <button type="button" onClick={() => fire(evolve)}>
                evolve
              </button>
              <button type="button" onClick={() => fire(arceus)}>
                arceus
              </button>
              <button type="button" onClick={() => fire(closingRitual)}>
                closing ritual
              </button>
              <button type="button" onClick={() => fire(toast)}>
                toast
              </button>
            </div>

            <button type="button" className="danger demo-console-exit" onClick={() => exitDemo()}>
              exit demo
            </button>
          </div>
      )}
    </div>
  );
}
