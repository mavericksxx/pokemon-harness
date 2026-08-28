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
import { bumpCounter } from '@/diagnosticsCounters';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { noteToolUse, resetLoopStreak } from './loopDetector';

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
  // Invariant counters (BACKLOG item 1 #3) — see diagnosticsCounters.ts's
  // file header for why this is renderer-scoped (main-side drops in
  // hookBridge.ts never reach here at all).
  bumpCounter('hookEventsReceived');
  lastHookAt.set(sessionId, Date.now());
  // A hook can arrive after the pty itself already exited (e.g. a trailing
  // Stop racing the process's own exit) — never resurrect a done session's
  // state, same guard the regex parser's idle timer uses.
  const live = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!live || live.status === 'done') {
    bumpCounter('hookEventsDropped');
    return;
  }
  bumpCounter('hookEventsRouted');
  const update = (patch: Parameters<ReturnType<typeof useStore.getState>['updateSession']>[1]): void =>
    useStore.getState().updateSession(sessionId, patch);

  switch (evt.event) {
    case 'SessionStart':
      // claudeSessionId is only ever added, never cleared, here: if a later
      // SessionStart (shouldn't happen mid-session, but be defensive) ever
      // arrived without one, silently dropping an already-captured id would
      // break disk-persisted `--resume` respawns for no reason.
      update({
        status: 'idle',
        tool: undefined,
        toolTarget: undefined,
        station: 'wander',
        ...(evt.claudeSessionId ? { claudeSessionId: evt.claudeSessionId } : {}),
        // Post-compact wake (item 4): a SessionStart whose `source` is
        // 'compact' is the one Claude Code fires right after it finishes
        // compacting — clear the nap the matching PreCompact set below.
        // Every other SessionStart (a fresh session) leaves napping alone
        // (it's already unset).
        ...(evt.source === 'compact' ? { napping: false } : {})
      });
      break;

    // Phase 8.5 Wave B item 4 — about to compact; nap until the post-compact
    // SessionStart above wakes it. Status/tool/station are left as-is: the
    // terminal stays live and Walker.setNapping (GardenScene's reconcile)
    // is what actually parks the walker and hides its tool bubble.
    case 'PreCompact':
      update({ napping: true });
      break;

    case 'UserPromptSubmit':
      // A fresh prompt is a clean slate for the loop breaker (Phase 8.5 #3).
      resetLoopStreak(sessionId);
      update({ status: 'working', tool: undefined, toolTarget: undefined, station: 'wander' });
      break;

    case 'PreToolUse': {
      const tool = evt.tool ?? '';
      // Emit BEFORE the store update: BattleManager must mark this session as
      // battling before GardenScene's reconcile sees the station change, or
      // the parent's walker briefly starts walking to a station this tick.
      // Isolated in its own try/catch so a throw anywhere in the battle path
      // can never abort the `update()` below (see the forensic writeup on
      // v1.1.0's disappearing subagent-battle spawns).
      if (tool === 'Task') {
        try {
          emitBattleSignal({ type: 'spawn', parentId: sessionId });
        } catch (err) {
          bumpCounter('battleSignalErrors');
          safeLogDiagnostic('battle-spawn', 'error', 'emitBattleSignal threw', {
            sessionId,
            event: evt.event,
            tool: evt.tool,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err)
          });
        }
        bumpCounter('subagentsSpawned');
      }
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
      // Loop breaker (Phase 8.5 #3) — this is the hooks-path convergence
      // point; ptyParser.ts's regex fallback has its own (no PostToolUse
      // equivalent exists in plain terminal text).
      noteToolUse(sessionId, evt.tool, evt.toolTarget);
      update({ status: 'working' });
      break;

    case 'Stop':
      update({ status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
      // A `Task` tool call blocks the parent's own turn until it genuinely
      // completes, so the parent reaching Stop is a DETERMINISTIC signal
      // that every subagent dispatched this turn is actually done — unlike
      // the opportunistic SubagentStop below (effectively never fires) and
      // the wall-clock fallback BattleManager.ts used to lean on instead
      // (see its file header: that fallback is what caused v1.2.0's
      // premature-death bug, a subagent's pokemon fainting while the real
      // subagent was still running). Isolated in its own try/catch, same
      // reasoning as the Task spawn signal above, and ordered after
      // `update()` so a battle-path throw can never skip the ordinary
      // status update.
      try {
        emitBattleSignal({ type: 'parentDone', parentId: sessionId });
      } catch (err) {
        bumpCounter('battleSignalErrors');
        safeLogDiagnostic('battle-parent-done', 'error', 'emitBattleSignal threw', {
          sessionId,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err)
        });
      }
      break;

    case 'SubagentStop':
      // Wired for the rare case the CLI actually sends it, but don't build
      // anything load-bearing on top: verified against real transcripts
      // (and matching public anthropics/claude-code issues #25147/#27755/
      // #33049) that Claude Code's Agent/Task tool dispatches every
      // subagent asynchronously and delivers its real completion as an
      // internal message that never reaches the hooks system at all — no
      // SubagentStop, not even UserPromptSubmit for the injected
      // notification. BattleManager's wander-safety timeout (see its file
      // header) is this app's actual, documented fallback for "a subagent
      // is done."
      emitBattleSignal({ type: 'end', parentId: sessionId });
      break;

    case 'Notification': {
      // Claude fires this hook both for a real permission/question prompt
      // AND for a plain "still there?" idle nudge after a quiet turn —
      // previously both mapped to the same 'blocked' ("needs you") badge,
      // over-triggering it for the merely-idle case. `notification_type` is
      // checked first when present, but it looks like a shim-era artifact
      // never actually confirmed against a real installed CLI the way
      // PreCompact was (see hookEvents.ts's own history) — this app can't
      // spawn a real session to verify it live (see this file's header), so
      // the primary discriminator is `message` text, matched against the
      // one idle wording Claude Code's own docs describe ("Claude is
      // waiting for your input"). Anything else — including an unrecognized
      // wording or no message at all — keeps today's behavior: a real
      // permission/question prompt, or a nudge this app doesn't recognize,
      // both still read as "needs you" rather than silently going idle.
      const notifType = evt.notificationType?.toLowerCase();
      const isIdleNudge =
        notifType === 'idle' || (notifType === undefined && /waiting for your input/i.test(evt.message ?? ''));
      if (isIdleNudge) {
        // Unlike Stop, this does NOT clear tool/toolTarget — an idle nudge
        // can fire while a tool call is genuinely still in flight (e.g. a
        // permission prompt on one tool doesn't mean nothing else is
        // running), and PostToolUse is what should retire those fields when
        // that call actually finishes, not this notification.
        update({ status: 'idle', station: 'wander' });
      } else {
        update({ status: 'blocked', station: 'signpost' });
      }
      break;
    }

    default:
      break;
  }
}
