import { useState } from 'react';
import { useStore } from '@/store/store';
import { forceRepaint } from '@/pty/terminalRegistry';

/**
 * Stale-argv indicator (reattach guard removal follow-up) — shown on a
 * session's own card when it was reattached to a keeper process (the "leave
 * them running" quit path) whose argv predates the current app version (see
 * `SessionRecord.staleArgv`, set by pty.ts's `tryReattach`). This app never
 * kills a session to refresh its own flags — that's the whole point of the
 * "leave them running" quit path — so the only way to pick up flags added
 * since (e.g. `--agents`) is this explicit, optional restart. Clicking it
 * calls `sessions:restartStale` (ipc/sessions.ts), which itself refuses (and
 * this chip surfaces the reason) rather than respawning a session with no
 * captured conversation id, since that would silently start a brand-new,
 * empty conversation instead of a refreshed one. The restart kills the old
 * process and resumes via `--resume` against its saved transcript — not a
 * live handoff, so anything typed in the brief kill→spawn window is not
 * carried over.
 */
export function StaleArgvChip({ sessionId }: { sessionId: string }): JSX.Element {
  const [restarting, setRestarting] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  if (blockedReason) {
    return (
      <span
        className="tip roster-card-stale-chip roster-card-stale-chip--blocked"
        data-tip={blockedReason}
        aria-label={blockedReason}
      >
        older session — can't auto-restart
      </span>
    );
  }

  return (
    <button
      type="button"
      className="tip roster-card-stale-chip"
      data-tip="running with an older version's flags — restart to update (optional; the conversation resumes from its saved transcript)"
      aria-label="older session — restart to update"
      disabled={restarting}
      onClick={async (e) => {
        e.stopPropagation();
        setRestarting(true);
        const result = await window.api.restartStaleSession(sessionId);
        setRestarting(false);
        if (!result.ok) {
          setBlockedReason(result.reason ?? "can't restart this session");
          return;
        }
        // The respawn already cleared `staleArgv` main-side (ipc/sessions.ts);
        // mirror it into the renderer's own store so this chip disappears
        // without waiting for a future checkpoint round-trip.
        useStore.getState().updateSession(sessionId, { staleArgv: false });
        // The new pty is spawned at a fixed 100x30 (pty.ts/sessionRespawn.ts)
        // into an xterm that's already sized to its real layout — without
        // this, the CLI's incremental, cursor-addressed redraw paints into
        // the wrong geometry until something else forces a full repaint.
        // Same fix hookRouter.ts's `SessionStart` case applies for a
        // fallback-shell relaunch.
        forceRepaint(sessionId);
      }}
    >
      {restarting ? 'restarting…' : 'older session — restart to update'}
    </button>
  );
}
