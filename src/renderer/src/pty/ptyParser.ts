/**
 * Scrape a coding-agent CLI's terminal output to derive session status.
 *
 * Adapted from munder-difflin (src/renderer/src/hooks/usePtyParser.ts), MIT,
 * Chaitanya Giri. Same regexes and the same idle-drift heuristic; converted from
 * a React hook to a plain factory because the parser must keep running while the
 * terminal drawer is CLOSED (the garden is driven by it), and a hook mounted in
 * the terminal panel could not do that.
 *
 * Also dropped: the god/sub-agent split (single-user — every session talks to
 * you) and the /context token sniffing (no context gauge in Phase 1).
 */
import { createAnsiStripper } from './ansiText';
import { useStore } from '@/store/store';
import { stationForTool } from '@/scene/garden/stations';

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

// "Blocked" = the CLI is genuinely waiting on the user. Match only real prompts.
// Do NOT match the bare word "permission": the TUI footer always shows "bypass
// permissions on (shift+tab to cycle)", which would flag a busy agent as blocked
// on every repaint — making it flip-flop between working and blocked.
const BLOCK_HINTS = [
  /Do you want to proceed/i,
  /❯\s*\d+\.\s*Yes/i, // numbered approval menu, cursor on "1. Yes"
  /Yes, and don't ask again/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i
];

/** Quiet period after which a session with no spinner is assumed idle. */
const IDLE_AFTER_MS = 4000;

export interface PtyParser {
  /** Feed one raw PTY chunk. */
  push(chunk: string): void;
  /** Cancel the pending idle timer. MUST be called when the session is torn
   *  down, or a dead walker keeps being flipped to idle. */
  dispose(): void;
}

export function createPtyParser(sessionId: string): PtyParser {
  const strip = createAnsiStripper();
  let idleTimer: number | null = null;

  const update = (patch: Parameters<ReturnType<typeof useStore.getState>['updateSession']>[1]): void => {
    useStore.getState().updateSession(sessionId, patch);
  };

  const cancelIdle = (): void => {
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdle = (): void => {
    cancelIdle();
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      const s = useStore.getState().sessions.find((x) => x.id === sessionId);
      if (!s || s.status === 'done') return;
      update({ status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
    }, IDLE_AFTER_MS);
  };

  return {
    push(chunk: string): void {
      const text = strip(chunk);
      if (!text.trim()) return;

      // The "esc to interrupt" footer is only shown while a turn is in progress.
      const running = /esc to interrupt/i.test(text);

      let lastTool: string | null = null;
      let lastArg = '';

      TOOL_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = TOOL_RE.exec(text)) !== null; ) {
        lastTool = m[1];
        lastArg = (m[2] ?? '').trim();
      }

      if (lastTool) {
        // Collapse space runs: translated cursor-forwards can stand for several
        // columns, and the bubble shouldn't show the gaps.
        const target = lastArg.replace(/\s+/g, ' ');
        update({
          status: 'working',
          tool: lastTool,
          toolTarget: target,
          station: stationForTool(lastTool)
        });
        if (running) cancelIdle();
        else scheduleIdle();
        return;
      }

      // Actively running but no fresh tool line (the model is thinking or
      // streaming prose) → keep it working, don't let it drift to idle.
      if (running) {
        cancelIdle();
        update({ status: 'working' });
        return;
      }

      // Not running → a genuine approval/question prompt may be on screen.
      const recent = text.slice(-400);
      if (BLOCK_HINTS.some((re) => re.test(recent))) {
        // Blocked is STICKY: an agent sitting at a permission prompt produces no
        // further output, so an idle timer here would quietly drop the one state
        // that actually needs your attention. It clears when the CLI prints
        // again, which is exactly when you have answered it.
        cancelIdle();
        update({ status: 'blocked', station: 'signpost' });
        return;
      }

      // Turn finished, no prompt on screen → let it drift to idle.
      scheduleIdle();
    },

    dispose(): void {
      cancelIdle();
    }
  };
}
