/**
 * External sessions plan §7 steps 4–5 — kill → await exit → resume for a
 * live session, plus the outside-write detector that auto-triggers it (or
 * shows a manual chip when the idle gate is closed).
 *
 * Split into its own file rather than added to sessions.ts (Lane B owns
 * `startSession` and the rest of that file's surface for the new-session
 * flow) — this only ever touches an ALREADY-live session under its own id.
 */
import { useStore } from '@/store/store';
import { recreateTerminal, forceRepaint } from '@/pty/terminalRegistry';

/** Reloads session `id`'s current process: kills it, awaits the real exit,
 *  then respawns via `claude --resume` against whatever conversation id is
 *  actually live (main/ipc/sessions.ts's `sessions:reload` handler picks
 *  that over a possibly-stale persisted one). Mirrors arceus.ts's
 *  `tryResumeArceus` — `recreateTerminal` (not a plain dispose+create) so a
 *  currently-open drawer's mount point survives the respawn, then a forced
 *  repaint so the CLI's incremental redraw paints into the terminal's real
 *  size instead of the new pty's fixed 100x30 spawn geometry.
 *
 *  Returns whether the reload actually happened. On failure (old process
 *  didn't exit in time, or no captured conversation id), the existing
 *  session is left completely untouched — callers must not show a
 *  disconnected card, only log/note the failure. */
export async function reloadSession(id: string): Promise<boolean> {
  const record = useStore.getState().sessions.find((s) => s.id === id);
  if (!record) return false;
  recreateTerminal(id, record.provider);
  const res = await window.api.reloadSession(id);
  if (!res.ok) {
    // Nothing was killed/spawned on the main side, so the terminal entry
    // just recreated above is subscribing to whatever pty is STILL live
    // under this id — harmless, but log so a failed reload isn't silent.
    // eslint-disable-next-line no-console
    console.warn('[sessionReload] reload failed', id, res.reason);
    return false;
  }
  useStore.getState().updateSession(id, {
    status: 'idle',
    cwd: res.cwd ?? record.cwd,
    claudeSessionId: res.claudeSessionId ?? record.claudeSessionId,
    exitCode: undefined
  });
  forceRepaint(id);
  return true;
}
