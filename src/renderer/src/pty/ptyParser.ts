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
import { clearHookAuthority, isHookAuthoritative } from './hookRouter';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';
import { noteToolUse, resetLoopStreak } from './loopDetector';

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

// Subagent-battle regex fallback (Part B) — Claude's transcript prints a Task
// tool call the same way as any other tool line: `● Task(description)`. There
// is no equivalent text signal for a subagent's completion, so the fallback
// heuristic ends the whole battle when the parent goes idle/blocked instead
// (see scheduleIdle/BLOCK_HINTS below) — subagents finish before their parent
// does, so this is late but never wrong.
const TASK_SPAWN_RE = /●\s+Task\(/g;

// "Blocked" = the CLI is genuinely waiting on the user. Match only real prompts.
// Do NOT match the bare word "permission": the TUI footer always shows "bypass
// permissions on (shift+tab to cycle)", which would flag a busy agent as blocked
// on every repaint — making it flip-flop between working and blocked.
const BLOCK_HINTS = [
  /Do you want to proceed/i,
  // Numbered approval menu, cursor on "1. Yes" (or "1. Yes, continue" etc).
  // ❯ (U+276F) is Claude's own cursor glyph; › (U+203A) is codex's — same
  // menu shape, different Unicode arrow, confirmed live against the real
  // codex CLI (its directory-trust prompt renders "› 1. Yes, continue").
  /[❯›]\s*\d+\.\s*Yes/i,
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
      // A timer armed before hooks became authoritative must not fire into a
      // now hook-owned session — this callback runs independently of push()'s
      // own guard, on a delay long enough for hooks to have taken over since
      // it was scheduled.
      if (isHookAuthoritative(sessionId)) return;
      const s = useStore.getState().sessions.find((x) => x.id === sessionId);
      if (!s || s.status === 'done') return;
      // Regex-fallback heuristic (Part B): no clean per-subagent completion
      // signal exists in plain text, so a battle this session started ends
      // when the parent itself goes idle — a no-op if none is active.
      emitBattleSignal({ type: 'endAll', parentId: sessionId });
      update({ status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
    }, IDLE_AFTER_MS);
  };

  return {
    push(chunk: string): void {
      const text = strip(chunk);
      // Hooks are authoritative once they start flowing for this session —
      // the stripper above still runs so its ANSI state stays consistent for
      // if/when fallback ever resumes, but nothing below may touch the store.
      if (isHookAuthoritative(sessionId)) return;
      if (!text.trim()) return;

      // Subagent-battle regex fallback: one spawn signal per NEW `● Task(`
      // occurrence in this chunk.
      TASK_SPAWN_RE.lastIndex = 0;
      while (TASK_SPAWN_RE.exec(text) !== null) {
        emitBattleSignal({ type: 'spawn', parentId: sessionId });
      }

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
        // Regex-fallback attack beat — a no-op unless this session is battling.
        emitBattleSignal({ type: 'attack', parentId: sessionId, tool: lastTool });
        // Loop breaker (Phase 8.5 #3) — the regex-fallback path's closest
        // analogue to a PostToolUse beat; see loopDetector.ts's header.
        noteToolUse(sessionId, lastTool, target);
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
        emitBattleSignal({ type: 'endAll', parentId: sessionId });
        update({ status: 'blocked', station: 'signpost' });
        return;
      }

      // Turn finished, no prompt on screen → let it drift to idle.
      scheduleIdle();
    },

    dispose(): void {
      cancelIdle();
      clearHookAuthority(sessionId);
      resetLoopStreak(sessionId);
    }
  };
}
