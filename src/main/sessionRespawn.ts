/**
 * Respawn logic for a disk-persisted session on app launch (Phase 8.5 #1).
 * Split out from main/index.ts, and parameterized on `PtyManager` rather than
 * reaching for a module-scope singleton, so both the argv construction and
 * the fallback-on-failure decision can be exercised from a plain script
 * against REAL spawned processes — main/index.ts itself imports `electron`'s
 * `app`/`ipcMain`, which only exist inside a running Electron process, so it
 * can't be required outside one.
 */
import { AGENT_PROVIDERS, buildProviderArgs, type AgentProviderId } from '../shared/agentProvider';
import { isGlobalSession } from '../shared/arceus';
import { loadArceusSummonConfig } from './arceusSummonConfig';
import type { PtyManager } from './pty';
import type { SessionRecord } from '../shared/types';
import { log } from './diagnostics';
import { RESUME_GRACE_MS } from '../shared/resumeTiming';

/** Bits `respawnSession` needs to check Arceus's saved summon config before
 *  relaunching him specifically — see that function's own comment. Mirrors
 *  exactly what `main/ipc/app.ts`'s `arceus:loadSummonConfig` handler already
 *  passes to `loadArceusSummonConfig` for the resummon path, so this reads
 *  the SAME source of truth rather than inventing a second one. */
export interface ArceusRespawnConfig {
  harnessHomeDir: string;
  defaultAgentProvider: AgentProviderId;
}

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
export async function respawnSession(
  ptyManager: PtyManager,
  record: SessionRecord,
  arceusConfig: ArceusRespawnConfig
): Promise<RespawnOutcome> {
  // "Leave them running" quit path (QuitDialog.tsx) — if this id's CLI
  // survived the last quit detached to its own keeper process, reattach to
  // it instead of spawning a brand-new one. Covers both "still running" and
  // "finished naturally while detached" correctly: the latter just fails to
  // reattach (its keeper already exited and cleaned up its socket) and
  // falls through to the unchanged spawn/resume logic below, same as a
  // session that was never detached in the first place.
  if (await ptyManager.tryReattach(record.id)) return { ok: true };

  const effective = await resolveEffectiveRespawn(record, arceusConfig);

  const useResume = shouldResume(effective);
  const primary = ptyManager.spawn({
    id: record.id,
    cwd: record.cwd,
    command: effective.command,
    args: respawnArgs(effective),
    provider: effective.provider,
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
  const fallback = ptyManager.spawnFallbackShellFromRespawn(record.id, record.cwd, effective.provider);
  if (!fallback.ok) return { ok: false };
  // Consumed here, not just read — this is the one place a boot-restore
  // failure's exit code is ever needed, so leaving it in `lastExitCodes`
  // after this point would just be a leak (see that map's own comment in
  // pty.ts).
  const exitCode = ptyManager.takeLastExitCode(record.id);
  log('pty', 'warn', 'session respawn fell back to shell', {
    id: record.id,
    provider: effective.provider,
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
 *  generic path via `respawnSession`, which resolves his EFFECTIVE
 *  provider/model from the saved summon config — `resolveEffectiveRespawn`
 *  below — before this function ever sees the record): a codex Arceus (per
 *  the saved config, regardless of what the stale on-disk record's own
 *  `provider` field says) simply respawns fresh here, persona re-typed on
 *  the renderer's next summon of him, same as arceus.ts's own
 *  `autoSummonArceus` already does for a mid-run (app-still-up) re-summon —
 *  see that function's comment for the parallel case. Not a gap to close:
 *  codex has no resumable-conversation flag in this app at all (no
 *  `--resume`-equivalent id captured for any codex session, Arceus or
 *  otherwise), so "fresh, persona re-typed" is the correct fallback rather
 *  than a workaround. */
export function shouldResume(record: SessionRecord): boolean {
  return record.provider === 'claude' && !!record.claudeSessionId;
}

/** Provider/model/command `respawnSession` actually uses for `record` — the
 *  record itself, unchanged, for every ordinary session. For Arceus
 *  specifically (`isGlobalSession`), overridden with whatever's currently
 *  saved in `agents/arceus/summon.json` (main/arceusSummonConfig.ts) — the
 *  SAME source of truth the reset-and-resummon flow already reads
 *  (`SummonArceusDialog.tsx` -> renderer's `arceus.ts` `summonArceus`), so a
 *  provider/model change made there is respected on the next app launch
 *  too, not just a mid-run resummon (this was the bug: this function used
 *  to just trust the stale on-disk `SessionRecord`, which only reflects
 *  whatever was live at the last quit). Falls back to `record` unchanged if
 *  Arceus was never summoned (no summon.json yet). `claudeSessionId` is
 *  left untouched either way — a captured id only matters when the
 *  (possibly overridden) provider is still 'claude', which `shouldResume`
 *  already gates on. */
async function resolveEffectiveRespawn(
  record: SessionRecord,
  arceusConfig: ArceusRespawnConfig
): Promise<SessionRecord> {
  if (!isGlobalSession(record)) return record;
  const saved = await loadArceusSummonConfig(arceusConfig.harnessHomeDir, arceusConfig.defaultAgentProvider);
  if (!saved) return record;
  return {
    ...record,
    provider: saved.provider,
    model: saved.model,
    command: AGENT_PROVIDERS[saved.provider].defaultCommand
  };
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
