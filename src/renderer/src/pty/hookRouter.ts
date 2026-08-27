/**
 * Routes normalized Claude Code hook events (Phase 4 Part A) into session
 * state. When hooks are flowing for a session they are the AUTHORITATIVE
 * state source — `ptyParser.ts` checks `isHookAuthoritative` and steps aside.
 *
 * Authority is latched, not windowed short: once a session's first hook
 * fires we trust hooks for the rest of its life, so a long-running `Bash`
 * with no hook chatter for a while can't make the regex parser fight the
 * hook state mid-tool-call. The only way back to regex fallback is genuine
 * silence — the documented "hooks go quiet on an old CLI version" case —
 * given a generous grace window so it never trips during ordinary work.
 */
import type { HookEvent } from '@shared/hookEvents';
import { useStore } from '@/store/store';
import { stationForTool } from '@/scene/garden/stations';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';

/** How long a claude session's hooks may go quiet before regex fallback
 *  resumes authority. Generous on purpose — see file header. */
const HOOK_SILENCE_MS = 60_000;

const lastHookAt = new Map<string, number>();

export function isHookAuthoritative(sessionId: string): boolean {
  const t = lastHookAt.get(sessionId);
  return t !== undefined && Date.now() - t < HOOK_SILENCE_MS;
}

/** Drop a session's hook-authority state — call on teardown so a reused id
 *  (shouldn't happen, but session ids are freshly generated per spawn) never
 *  inherits stale authority. */
export function clearHookAuthority(sessionId: string): void {
  lastHookAt.delete(sessionId);
}

export function handleHookEvent(sessionId: string, evt: HookEvent): void {
  lastHookAt.set(sessionId, Date.now());
  // A hook can arrive after the pty itself already exited (e.g. a trailing
  // Stop racing the process's own exit) — never resurrect a done session's
  // state, same guard the regex parser's idle timer uses.
  const live = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!live || live.status === 'done') return;
  const update = (patch: Parameters<ReturnType<typeof useStore.getState>['updateSession']>[1]): void =>
    useStore.getState().updateSession(sessionId, patch);

  switch (evt.event) {
    case 'SessionStart':
      update({ status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
      break;

    case 'UserPromptSubmit':
      update({ status: 'working', tool: undefined, toolTarget: undefined, station: 'wander' });
      break;

    case 'PreToolUse': {
      const tool = evt.tool ?? '';
      // Emit BEFORE the store update: BattleManager must mark this session as
      // battling before GardenScene's reconcile sees the station change, or
      // the parent's walker briefly starts walking to a station this tick.
      if (tool === 'Task') emitBattleSignal({ type: 'spawn', parentId: sessionId });
      update({
        status: 'working',
        tool: evt.tool,
        toolTarget: evt.toolTarget || undefined,
        station: stationForTool(evt.tool)
      });
      break;
    }

    case 'PostToolUse':
      // A tool call that actually ran — during an active battle this is one
      // attack beat (BattleManager no-ops if this session isn't battling).
      if (evt.tool) emitBattleSignal({ type: 'attack', parentId: sessionId, tool: evt.tool });
      update({ status: 'working' });
      break;

    case 'Stop':
      update({ status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
      break;

    case 'SubagentStop':
      emitBattleSignal({ type: 'end', parentId: sessionId });
      break;

    case 'Notification':
      // Claude fires this precisely when it wants the user — permission
      // prompt or an idle nudge alike — so it always reads as "needs you".
      update({ status: 'blocked', station: 'signpost' });
      break;

    default:
      break;
  }
}
