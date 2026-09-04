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
import type { DelegateHookSignal, HookEvent } from '@shared/hookEvents';
import { useStore } from '@/store/store';
import { stationForTool } from '@/scene/garden/stations';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';
import { emitAdvisorSignal } from '@/scene/garden/battle/advisorBus';
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

/** Bug B fix (2026-08-29) — count of async `Task`/`Agent` dispatches this
 *  session has launched (per taskNotificationWatcher.ts's `toolUseResult.
 *  isAsync` detection) that haven't yet been terminally notified. Gates the
 *  `Stop` case below: `Stop` only counts as subagent-completion proof when
 *  this is 0 for that session — see taskNotificationWatcher.ts's header for
 *  the full evidence this is built on. Registered once, at module load,
 *  mirroring `onArceusRelayUnresolved`'s single-global-listener pattern
 *  (arceus.ts) — every parent session's events funnel through the same two
 *  channels, so there's no natural per-session subscribe/unsubscribe point
 *  the way `onHookEvent`/`onCostUpdate` have (terminalRegistry.ts). */
const pendingAsyncLaunches = new Map<string, number>();

/** True while `parentId` has at least one async dispatch launched (per the
 *  transcript watcher) that hasn't yet been terminally notified. Exported so
 *  BattleManager.ts can re-check it at the ONE OTHER site that can queue a
 *  roaming sub off a Stop-derived signal — `updateOneBattle`'s
 *  `queueEligibleAt` firing, for a sub that was too young to queue
 *  immediately when `Stop` first arrived (see `handleParentDone` below).
 *  Without that second check, the very race this fix exists to close still
 *  gets through: `pendingAsyncLaunches` is fed by a POLLED transcript watch
 *  (~2s), so the Stop that fires ~200ms after an async dispatch's PostToolUse
 *  can land before the poller has ever seen the launch line — the gate here
 *  reads 0, `Stop` passes through, and `queueEligibleAt` (armed for
 *  `MIN_ROAM_MS` later) fires UNCONDITIONALLY unless that later check ALSO
 *  consults this same counter. By the time `MIN_ROAM_MS` (15s) has elapsed,
 *  the poller has had many chances to see the launch line, so this correctly
 *  reads outstanding by then for a real async dispatch. */
export function hasPendingAsyncSubagents(parentId: string): boolean {
  return (pendingAsyncLaunches.get(parentId) ?? 0) > 0;
}

window.api.onAsyncSubagentLaunch((agentId) => {
  pendingAsyncLaunches.set(agentId, (pendingAsyncLaunches.get(agentId) ?? 0) + 1);
});

window.api.onSubagentTaskNotification((agentId, taskId) => {
  const n = pendingAsyncLaunches.get(agentId) ?? 0;
  if (n > 0) pendingAsyncLaunches.set(agentId, n - 1);
  // A real per-subagent completion, whatever its status — reuses the
  // existing 'end' signal, now carrying the exact CLI-internal task-id
  // (battler ↔ task-id correlation fix) so BattleManager.handleEnd retires
  // the battler actually stamped with it, falling back to the old "queue the
  // oldest roaming sub for this parent" heuristic only for a battler that
  // never got stamped. The sole source of 'end' now — see the `SubagentStop`
  // case below for why that hook no longer also feeds it. Isolated in its
  // own try/catch, same reasoning as every other emitBattleSignal call site
  // in this file.
  try {
    emitBattleSignal({ type: 'end', parentId: agentId, taskId });
  } catch (err) {
    bumpCounter('battleSignalErrors');
    safeLogDiagnostic('battle-task-notification', 'error', 'emitBattleSignal threw', {
      sessionId: agentId,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    });
  }
  // Belt-and-braces forward into the advisor bus too (advisor-pokemon
  // feature) — this notification doesn't know in advance whether `taskId`
  // belongs to an ordinary battler or an advisor companion, so it's forwarded
  // to both. Cross-manager mis-recall fix (2026-09-04): each manager narrows
  // its own "unrecognized taskId" fallback to candidates it never stamped
  // with a taskId of their own (never grabbing an already-identified
  // companion/battler that just happens not to match this one), and — to
  // close the remaining race where a genuinely-unstamped-but-real
  // companion/sub exists at the exact moment the OTHER manager's taskId
  // arrives here — each manager's own `handleCorrelate` records a taskId as
  // foreign the moment its correlate lookup confirms the id isn't its
  // domain's, and `handleEnd` checks that record first and no-ops
  // immediately. See AdvisorManager.ts's and BattleManager.ts's own
  // `foreignTaskIds` doc comments for the full mechanism. Isolated in its
  // own try/catch so a throw on this side can never affect the battle emit
  // above.
  try {
    emitAdvisorSignal({ type: 'end', parentId: agentId, taskId });
  } catch (err) {
    bumpCounter('battleSignalErrors');
    safeLogDiagnostic('advisor-task-notification', 'error', 'emitAdvisorSignal threw', {
      sessionId: agentId,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    });
  }
});

// Battler ↔ task-id correlation (2026-08-29 fix) — see battleBus.ts's
// 'correlate' signal and BattleManager.ts's `handleCorrelate` for what this
// pair drives (exact-id stamping, plus resume re-materialization).
window.api.onTaskCorrelated((agentId, toolUseId, taskId) => {
  try {
    emitBattleSignal({ type: 'correlate', parentId: agentId, toolUseId, taskId });
  } catch (err) {
    bumpCounter('battleSignalErrors');
    safeLogDiagnostic('battle-correlate', 'error', 'emitBattleSignal threw', {
      sessionId: agentId,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    });
  }
  // Belt-and-braces forward into the advisor bus too — see the matching
  // comment on `onSubagentTaskNotification` above for why.
  try {
    emitAdvisorSignal({ type: 'correlate', parentId: agentId, toolUseId, taskId });
  } catch (err) {
    bumpCounter('battleSignalErrors');
    safeLogDiagnostic('advisor-correlate', 'error', 'emitAdvisorSignal threw', {
      sessionId: agentId,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    });
  }
});

// External-codex-delegate feature — codexSessionId -> parentId while a
// battler spawned by its SessionStart is still live, so a codex retry firing
// SessionStart a second time can't double-spawn (item 3's dedupe
// requirement), and a Stop with no matching entry is a logged no-op instead
// of an 'end' signal fired at nothing. Cleared on Stop, so a genuinely later
// delegate reusing the same codexSessionId (or the same parent+label
// fallback key — see hookBridge.ts's `handleDelegate`) can spawn again. Also
// swept by `clearHookAuthority` below: if the parent session dies before the
// delegate's Stop arrives, hookBridge.ts's `isKnownSession` check drops that
// Stop entirely (no known parent to route it to) and this map would
// otherwise hold the key forever — the value is the parentId precisely so
// that teardown can find and remove it.
const seenDelegateStarts = new Map<string, string>();

window.api.onDelegateHookEvent((signal: DelegateHookSignal) => {
  if (signal.event === 'SessionStart') {
    if (seenDelegateStarts.has(signal.codexSessionId)) return; // codex retry — already spawned
    seenDelegateStarts.set(signal.codexSessionId, signal.parentId);
    // Reuses the exact spawn->correlate pairing a real `Task` dispatch goes
    // through (battleBus.ts's 'spawn'/'correlate' signals), stamping the
    // codex session id as both `toolUseId` and `taskId` up front since,
    // unlike a Task dispatch, the delegate's one true identity is already
    // known at spawn time — no separate correlation event will ever arrive.
    // `handleSpawn` materializes synchronously (BattleManager.ts), so the
    // battler already carries `toolUseId` by the time `handleCorrelate`
    // looks for it here.
    try {
      emitBattleSignal({ type: 'spawn', parentId: signal.parentId, label: signal.label, toolUseId: signal.codexSessionId });
      emitBattleSignal({
        type: 'correlate',
        parentId: signal.parentId,
        toolUseId: signal.codexSessionId,
        taskId: signal.codexSessionId
      });
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('battle-delegate', 'error', 'emitBattleSignal threw', {
        parentId: signal.parentId,
        codexSessionId: signal.codexSessionId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }
  } else {
    if (!seenDelegateStarts.has(signal.codexSessionId)) {
      safeLogDiagnostic('battle-delegate', 'info', 'delegate Stop with no matching battler — no-op', {
        parentId: signal.parentId,
        codexSessionId: signal.codexSessionId
      });
      return;
    }
    seenDelegateStarts.delete(signal.codexSessionId);
    try {
      emitBattleSignal({ type: 'end', parentId: signal.parentId, taskId: signal.codexSessionId });
    } catch (err) {
      bumpCounter('battleSignalErrors');
      safeLogDiagnostic('battle-delegate', 'error', 'emitBattleSignal threw', {
        parentId: signal.parentId,
        codexSessionId: signal.codexSessionId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err)
      });
    }
  }
});

/** Drop a session's hook-authority + async-dispatch tracking — call on
 *  teardown so a reused id (shouldn't happen, but session ids are freshly
 *  generated per spawn) never inherits stale state. */
export function clearHookAuthority(sessionId: string): void {
  lastHookAt.delete(sessionId);
  pendingAsyncLaunches.delete(sessionId);
  // External-codex-delegate feature — a torn-down parent's Stop never
  // reaches the renderer (hookBridge.ts's `isKnownSession` drops it once the
  // parent's pty is gone), so without this sweep a delegate spawned under it
  // would leak its dedupe-map entry forever. The battler itself is fine
  // either way (killing a session drops its battlers directly, and
  // MAX_ROAM_MS backstops anything that survives that).
  for (const [codexSessionId, parentId] of seenDelegateStarts) {
    if (parentId === sessionId) seenDelegateStarts.delete(codexSessionId);
  }
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
      // A subagent-scoped hook is still processed as the parent's event below
      // (the existing status/tool derivation and Task spawn behavior stay
      // unchanged), but it also gets a parallel battle-only fanout so a
      // roaming battler can show the actual tool it is running. This is
      // best-effort: HookBridge's parent-channel tagging is known to be
      // unreliable for some subagent captures, and those events are simply
      // absent here.
      if (evt.agent_id && tool) {
        try {
          emitBattleSignal({
            type: 'subTool',
            parentId: sessionId,
            subagentId: evt.agent_id,
            tool,
            toolTarget: evt.toolTarget ?? ''
          });
        } catch (err) {
          bumpCounter('battleSignalErrors');
          safeLogDiagnostic('battle-sub-tool', 'error', 'emitBattleSignal threw', {
            sessionId,
            subagentId: evt.agent_id,
            tool,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err)
          });
        }
      }
      // Emit BEFORE the store update: BattleManager must mark this session as
      // battling before GardenScene's reconcile sees the station change, or
      // the parent's walker briefly starts walking to a station this tick.
      // Isolated in its own try/catch so a throw anywhere in the battle path
      // can never abort the `update()` below (see the forensic writeup on
      // v1.1.0's disappearing subagent-battle spawns).
      if (tool === 'Task') {
        // advisor-pokemon feature: a Task dispatch whose raw `subagent_type`
        // is literally 'advisor' (the global `advisor` agent this app's own
        // sessions consult before architecture decisions/deliverables — see
        // BACKLOG.md) gets an instantly-recognizable hovering companion
        // instead of an ordinary wild-battler completion battle. THREE
        // MUTUALLY EXCLUSIVE cases, exactly one fires per dispatch:
        //   1. subagent_type 'advisor' dispatched by the top-level session
        //      (no `evt.agent_id`) → spawn a companion.
        //   2. subagent_type 'advisor' dispatched FROM WITHIN an
        //      already-running subagent (`evt.agent_id` present — Claude
        //      Code's own "this hook fired inside subagent X" stamp, see
        //      shared/hookEvents.ts) → spawn NOTHING. A nested advisor
        //      consult is a sidechain transcript entry
        //      (`entry.isSidechain === true`), and taskNotificationWatcher.ts
        //      deliberately excludes sidechain entries from ever producing a
        //      correlate/end signal (same convention as costWatcher.ts and
        //      arceusRelay.ts) — so a companion spawned here could never be
        //      despawned via that path and would sit orphaned until
        //      AdvisorManager's MAX_COMPANION_LIFETIME_MS backstop. Falling
        //      back to an ordinary battle-spawn instead would trade one
        //      orphan for another (same bug, different sprite), so this case
        //      spawns neither — see taskNotificationWatcher.ts's sidechain
        //      filter for the other half of this fix.
        //   3. Not an advisor dispatch at all → ordinary wild-battler spawn.
        // An advisor consult (cases 1 and 2) must never also roam/queue/
        // battle as a regular subagent, and an ordinary subagent must never
        // spawn a companion.
        const isAdvisor = evt.subagentType === 'advisor' && !evt.agent_id;
        const isNestedAdvisor = evt.subagentType === 'advisor' && !!evt.agent_id;
        if (isAdvisor) {
          try {
            emitAdvisorSignal({ type: 'spawn', parentId: sessionId, toolUseId: evt.toolUseId });
          } catch (err) {
            bumpCounter('battleSignalErrors');
            safeLogDiagnostic('advisor-spawn', 'error', 'emitAdvisorSignal threw', {
              sessionId,
              event: evt.event,
              tool: evt.tool,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err)
            });
          }
        } else if (isNestedAdvisor) {
          safeLogDiagnostic(
            'advisor',
            'info',
            'advisor companion spawn skipped — nested/sidechain dispatch, would orphan (no correlate path exists for sidechain)',
            {
              sessionId,
              parentId: sessionId,
              subagentId: evt.agent_id,
              toolTarget: evt.toolTarget,
              toolUseId: evt.toolUseId
            }
          );
        } else {
          try {
            // Parity sweep item 7 — `evt.toolTarget` for a `Task` PreToolUse
            // is `toolTargetFromInput`'s `description`-or-`subagent_type` pick
            // off this exact tool call's own input (shared/hookEvents.ts) —
            // the one real "name" a subagent has at spawn time. Passed in the
            // signal itself, not read back from the store below: `update()`
            // right after this will overwrite `session.toolTarget` again on
            // this session's very next tool call, so capturing it here is the
            // only reliable moment. `evt.toolUseId` (battler ↔ task-id
            // correlation fix) is this exact dispatch's `tool_use_id` — the one
            // identity available at spawn time, before any CLI-internal
            // task-id exists (see hookEvents.ts's `HookPayload.tool_use_id`).
            emitBattleSignal({
              type: 'spawn',
              parentId: sessionId,
              label: evt.toolTarget || undefined,
              toolUseId: evt.toolUseId
            });
          } catch (err) {
            bumpCounter('battleSignalErrors');
            safeLogDiagnostic('battle-spawn', 'error', 'emitBattleSignal threw', {
              sessionId,
              event: evt.event,
              tool: evt.tool,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err)
            });
          }
          // Not bumped for an advisor dispatch: this counter is paired with
          // `subagentsMaterialized` (BattleManager.handleSpawn) as an
          // invariant check — an advisor companion never bumps that one
          // (AdvisorManager has no equivalent), so counting it here would
          // introduce a permanent, expected mismatch that'd mask a real drop.
          bumpCounter('subagentsSpawned');
        }
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
      // completes — for a SYNCHRONOUS dispatch, which makes the parent
      // reaching Stop a deterministic "every subagent dispatched this turn
      // is actually done" signal, same as before this fix. FALSE for an
      // ASYNC dispatch, though (confirmed live — see taskNotificationWatcher
      // .ts's header): PostToolUse for an async `Agent` call fires within
      // ~100-200ms, well before the real subagent finishes, so an unqualified
      // Stop can and does fire while it's still working (the exact
      // 2026-08-28 production bug this gate fixes: a battler's completion
      // battle fired ~100s after spawn while its subagent kept running for
      // ~10 more minutes). No live evidence a synchronous Agent/Task dispatch
      // exists at all in the installed CLI — every real capture came back
      // async — so this gate is believed to make Stop a no-op for battle
      // purposes in practice today; it's kept (rather than deleting this
      // signal outright) on the chance a synchronous dispatch DOES exist
      // (some future/variant path this app hasn't observed), so that case
      // keeps working exactly as before. Isolated in its own try/catch, same
      // reasoning as the Task spawn signal above, and ordered after
      // `update()` so a battle-path throw can never skip the ordinary status
      // update.
      //
      // This check ALONE doesn't close the race, though: `pendingAsync
      // Launches` is fed by a polled transcript watch (~2s), so a Stop
      // firing ~200ms after an async dispatch can still read 0 here, before
      // the poller has ever seen the launch line — see
      // `hasPendingAsyncSubagents`'s own doc comment for why BattleManager's
      // `updateOneBattle` re-checks the SAME counter at the one other site
      // that can queue a roaming sub off this path (`queueEligibleAt`,
      // MIN_ROAM_MS later — by which point the poller has had many chances
      // to catch up).
      if (!hasPendingAsyncSubagents(sessionId)) {
        try {
          emitBattleSignal({ type: 'parentDone', parentId: sessionId });
        } catch (err) {
          bumpCounter('battleSignalErrors');
          safeLogDiagnostic('battle-parent-done', 'error', 'emitBattleSignal threw', {
            sessionId,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err)
          });
        }
      } else {
        safeLogDiagnostic('battle-parent-done', 'info', 'Stop skipped — async subagent(s) still outstanding', {
          sessionId,
          pendingAsyncLaunches: pendingAsyncLaunches.get(sessionId)
        });
      }
      break;

    case 'SubagentStop':
      // Wired, and DOES fire (confirmed live in two independent captures —
      // see taskNotificationWatcher.ts's header — contradicting this file's
      // own prior comment here, which claimed it "effectively never fires").
      // No longer forwarded into a battle signal, though: its own
      // `harness_agent_id` tagging was NOT reliable across those two
      // captures (one tagged it with the PARENT's own harness agentId, the
      // other with the CLI's internal subagent id instead — which routes to
      // an IPC channel no renderer listens on, see hookBridge.ts's per-
      // agentId `wc.send`), and it carries no CLI-internal task-id `handleEnd`
      // could retire by — even with the battler ↔ task-id correlation fix
      // (BattleManager.ts), an untagged `SubagentStop` has no way to tell
      // "this is the SAME completion the transcript watcher already
      // reported" from "this is a genuinely different subagent finishing" —
      // double-firing 'end' for one real
      // completion would queue an unrelated, still-working sibling's
      // battler, exactly the premature-death bug this whole fix exists to
      // remove. The transcript-based `onSubagentTaskNotification` listener
      // above is reliably tagged (registered per this app's OWN harness
      // agentId, never the CLI's internal one) and is now the sole trigger
      // for this path.
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
