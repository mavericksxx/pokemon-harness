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
import { log } from './diagnostics';
import { RESUME_GRACE_MS } from '../shared/resumeTiming';

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
 *  The fallback is a shell process, but retains the original provider metadata
 *  so the shell's PATH shims can make a hand-relaunched CLI behave like the
 *  original session.
 */
export async function respawnSession(ptyManager: PtyManager, record: SessionRecord): Promise<RespawnOutcome> {
  // "Leave them running" quit path (QuitDialog.tsx) — if this id's CLI
  // survived the last quit detached to its own keeper process, reattach to
  // it instead of spawning a brand-new one. Covers both "still running" and
  // "finished naturally while detached" correctly: the latter just fails to
  // reattach (its keeper already exited and cleaned up its socket) and
  // falls through to the unchanged spawn/resume logic below, same as a
  // session that was never detached in the first place.
  if (await ptyManager.tryReattach(record.id)) return { ok: true };

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

  const reason = primary.ok
    ? 'the claude session could not be resumed'
    : (primary.error ?? 'the original command could not be restarted');
  const fallback = ptyManager.spawnFallbackShellFromRespawn(record.id, record.cwd, record.provider);
  if (!fallback.ok) return { ok: false };
  // Consumed here, not just read — this is the one place a boot-restore
  // failure's exit code is ever needed, so leaving it in `lastExitCodes`
  // after this point would just be a leak (see that map's own comment in
  // pty.ts).
  const exitCode = ptyManager.takeLastExitCode(record.id);
  log('pty', 'warn', 'session respawn fell back to shell', {
    id: record.id,
    provider: record.provider,
    reason,
    ...(exitCode === undefined ? {} : { exitCode })
  });
  return { ok: true, fallbackReason: reason };
}

/** Whether `record` should be resumed (vs. respawned fresh). Claude-only by
 *  design — `claudeSessionId` is only ever captured for a claude session
 *  (hookRouter.ts's SessionStart case). This also governs a disk-persisted
 *  Arceus record on app relaunch (provider-aware Arceus, BACKLOG item 1 —
 *  `restoreFromDisk` in main/index.ts respawns him through this same
 *  generic path, no Arceus-specific branch): a codex Arceus simply
 *  respawns fresh here, persona re-typed on the renderer's next summon of
 *  him, same as arceus.ts's own `autoSummonArceus` already does for a
 *  mid-run (app-still-up) re-summon — see that function's comment for the
 *  parallel case. Not a gap to close: codex has no resumable-conversation
 *  flag in this app at all (no `--resume`-equivalent id captured for any
 *  codex session, Arceus or otherwise), so "fresh, persona re-typed" is the
 *  correct fallback rather than a workaround. */
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
