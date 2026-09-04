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
 * you) and the /context token sniffing (no context gauge in Phase 1). The
 * parser still understands non-Claude output for status/tool presentation, but
 * only Claude sessions are allowed to derive battle signals from regex text.
 */
import { createAnsiStripper } from './ansiText';
import { useStore } from '@/store/store';
import { stationForTool } from '@/scene/garden/stations';
import { clearHookAuthority, isHookAuthoritative } from './hookRouter';
import { emitBattleSignal, type BattleSignal } from '@/scene/garden/battle/battleBus';
import { noteToolUse, resetLoopStreak } from './loopDetector';
import type { AgentProviderId } from '@shared/agentProvider';

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

// codex doesn't use Claude's `● Tool` bullet at all — confirmed live (real
// codex CLI, gpt-5.6-luna, v0.150.1, four trivial prompts in one scratch-dir
// session) against three distinct shapes:
//   `• Ran <command>`                — a direct shell execution
//   `• Edited <file> (+N -M)`        — a file edit, diff lines follow
//   `  └ <Verb> <target>`            — under an "Exploring"/"Explored"
//                                      heading; List (a shell-based listing/
//                                      search) and Read (a file read) are the
//                                      two verbs actually observed.
// Mapped onto this app's EXISTING Claude-tool vocabulary (Bash/Edit/Read)
// below rather than inventing codex-specific stations/SFX — stationForTool,
// toolIcon and loopDetector's noteToolUse all already key off those names.
// Bounded to stop before the next bullet/heading marker (•, ›, └), not just
// newline: a mid-redraw chunk can glue this line straight onto trailing
// status chrome with no newline in between (confirmed live — a raw capture
// swallowed a following " • Working (Ns • esc to interrupt) · ..." footer
// as part of the "target" text otherwise).
//
// That prior tightening pass only covers footer text starting with one of
// •›└. It does NOT cover a mid-redraw chunk that glues the footer's own
// leftover second-counter directly onto "Ran "/"List "/"Read " with nothing
// but a bare digit before the next stop char (issue #1: rendered as the
// bubble text `$ running 3`). A real shell command's first word is never a
// bare number, so a `(?!\s*\d+...)` guard right after the verb rejects
// exactly that shape — and only that shape — without narrowing what a
// legitimate capture can contain. The lookahead's own `\s*` (rather than
// relying on the preceding `\s+` to have landed exactly on the digit) matters
// because `\s+` is greedy-but-backtrackable: without it, an extra space
// before the glued digit (translated cursor-forwards routinely stand for
// several columns — see the space-collapse below) would let `\s+` give one
// space back so the lookahead's `\d+` starts clean, sliding the leading
// space into the capture instead of being rejected.
const CODEX_RAN_RE = /•\s+Ran\s+(?!\s*\d+(?:[\s•›└]|$))([^\n•›└]+)/g;
const CODEX_EDITED_RE = /•\s+Edited\s+([^\n•›└(]+)/g;
const CODEX_SUBACTION_RE = /└\s+(List|Read)\s+(?!\s*\d+(?:[\s•›└]|$))([^\n•›└]+)/g;
const CODEX_VERB_TO_TOOL: Record<string, string> = { List: 'Bash', Read: 'Read' };

// Subagent-battle regex fallback (Part B) — Claude's transcript prints a Task
// tool call the same way as any other tool line: `● Task(description)`. There
// is no equivalent text signal for a subagent's completion, so the Claude-only
// fallback heuristic ends the whole battle when the parent goes idle/blocked
// instead (see scheduleIdle/BLOCK_HINTS below) — subagents finish before their
// parent does, so this is late but never wrong.
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

export function createPtyParser(sessionId: string, provider: AgentProviderId): PtyParser {
  const strip = createAnsiStripper();
  let idleTimer: number | null = null;
  // Keep ordinary status/tool derivation provider-agnostic, but keep battle
  // heuristics Claude-only. Non-Claude CLIs can print text that resembles
  // Claude's Task/tool output without having a hook-backed subagent signal.
  // This gate intentionally leaves every status update below intact.
  const canEmitBattleSignals = provider === 'claude';
  const emitBattle = (signal: BattleSignal): void => {
    if (canEmitBattleSignals) emitBattleSignal(signal);
  };

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
      emitBattle({ type: 'endAll', parentId: sessionId });
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
        emitBattle({ type: 'spawn', parentId: sessionId });
      }

      // The "esc to interrupt" footer is only shown while a turn is in progress.
      const running = /esc to interrupt/i.test(text);

      let lastTool: string | null = null;
      let lastArg = '';
      // Tracks the LATEST match across all four patterns (Claude's bullet
      // plus codex's three shapes) by position in this chunk, so whichever
      // provider's convention actually appears wins — a given session only
      // ever emits one of them, but this keeps the scan provider-agnostic
      // rather than branching on `session.provider`.
      let lastMatchIndex = -1;
      const record = (index: number, tool: string, arg: string): void => {
        if (index < lastMatchIndex) return;
        lastMatchIndex = index;
        lastTool = tool;
        lastArg = arg.trim();
      };

      TOOL_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = TOOL_RE.exec(text)) !== null; ) {
        record(m.index, m[1], m[2] ?? '');
      }
      CODEX_RAN_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = CODEX_RAN_RE.exec(text)) !== null; ) {
        record(m.index, 'Bash', m[1]);
      }
      CODEX_EDITED_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = CODEX_EDITED_RE.exec(text)) !== null; ) {
        record(m.index, 'Edit', m[1]);
      }
      CODEX_SUBACTION_RE.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = CODEX_SUBACTION_RE.exec(text)) !== null; ) {
        const tool = CODEX_VERB_TO_TOOL[m[1]];
        if (tool) record(m.index, tool, m[2] ?? '');
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
        emitBattle({ type: 'attack', parentId: sessionId, tool: lastTool });
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
        emitBattle({ type: 'endAll', parentId: sessionId });
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
