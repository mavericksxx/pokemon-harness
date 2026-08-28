/**
 * Respawn logic for a disk-persisted session on app launch (Phase 8.5 #1).
 * Split out from main/index.ts, and parameterized on `PtyManager` rather than
 * reaching for a module-scope singleton, so both the argv construction and
 * the fallback-on-failure decision can be exercised from a plain script
 * against REAL spawned processes — main/index.ts itself imports `electron`'s
 * `app`/`ipcMain`, which only exist inside a running Electron process, so it
 * can't be required outside one.
 */
import { buildProviderArgs } from '../shared/agentProvider';
import type { PtyManager } from './pty';
import type { SessionRecord } from '../shared/types';

/** Grace period a `claude --resume` respawn gets before it's trusted to
 *  actually be alive — an invalid/expired session id makes the CLI print an
 *  error and exit almost immediately, which a bare successful spawn() can't
 *  detect (the binary itself started fine). Only the resume path waits this
 *  out; a fresh respawn of a plain command has no equivalent failure mode to
 *  guard against. */
export const RESUME_GRACE_MS = 4000;

export interface RespawnOutcome {
  ok: boolean;
  /** Set when the ORIGINAL command/resume failed and this is a plain-shell
   *  substitute instead — `restoreFromDisk` (main/index.ts) turns this into a
   *  toast note. */
  fallbackReason?: string;
}

/** Respawn one persisted session under its original id. Tries the recorded
 *  command first (claude sessions with a captured id resume via
 *  `claude --resume`); on any failure — command missing, or (resume only) an
 *  exit inside the grace window — falls back to a plain shell in the same
 *  cwd rather than dropping the session, per the "not a crash" requirement.
 *  The fallback spawn deliberately omits `provider`: it is a bare shell, not
 *  a claude/codex/cursor-agent process, so it must not pick up the
 *  claude-only `--settings`/hook-env wiring pty.ts's spawn() adds for that
 *  provider — a stray `--settings <path>` argv would just look like a
 *  malformed script argument to a real shell. */
export async function respawnSession(ptyManager: PtyManager, record: SessionRecord): Promise<RespawnOutcome> {
  const useResume = shouldResume(record);
  const primary = ptyManager.spawn({
    id: record.id,
    cwd: record.cwd,
    command: record.command,
    args: respawnArgs(record),
    provider: record.provider,
    cols: 100,
    rows: 30
  });

  if (primary.ok) {
    if (!useResume) return { ok: true };
    const alive = await ptyManager.waitAlive(record.id, RESUME_GRACE_MS);
    if (alive) return { ok: true };
    // Exited inside the grace window — treat as a failed resume. The dead
    // pty already removed itself from ptyManager on its own exit.
  }

  const shell = process.env.SHELL || '/bin/bash';
  const fallback = ptyManager.spawn({ id: record.id, cwd: record.cwd, command: shell, cols: 100, rows: 30 });
  if (!fallback.ok) return { ok: false };
  const reason = primary.ok
    ? 'the claude session could not be resumed'
    : (primary.error ?? 'the original command could not be restarted');
  return { ok: true, fallbackReason: reason };
}

/** Whether `record` should be resumed (vs. respawned fresh). */
export function shouldResume(record: SessionRecord): boolean {
  return record.provider === 'claude' && !!record.claudeSessionId;
}

/** Args for a persisted session's respawn — BEFORE pty.ts's claude-only
 *  `--settings` append (spawn() does that itself, same as it does for a
 *  brand-new session). A claude session with a captured `claudeSessionId`
 *  resumes that conversation; anything else (non-claude, or a claude session
 *  from before this field existed) respawns the original command fresh,
 *  matching what `startSession` (src/renderer/src/sessions.ts) built the
 *  first time. */
export function respawnArgs(record: SessionRecord): string[] {
  if (shouldResume(record)) return ['--resume', record.claudeSessionId as string];
  return buildProviderArgs(record.provider, record.model);
}
