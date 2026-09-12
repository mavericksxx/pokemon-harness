/**
 * Arceus's live roster file (BACKLOG "next up" item 3 follow-up: give Arceus
 * a self-serve source of truth) — `agents/arceus/roster.json` in the harness
 * home directory (same dir as SYSTEM.md / summon.json — see arceusPrompt.ts
 * / arceusSummonConfig.ts). Closes the gap the per-message `[roster: ...]`
 * tag (formatRosterLine, ArceusDispatchBox.tsx) can't: a message typed
 * directly into Arceus's own terminal pane carries no fresh tag, so this
 * file is what he can read with his own tools instead of trusting a
 * remembered roster.
 *
 * Regenerated from `main/index.ts`'s `sessions:checkpoint` handler, right
 * alongside `pokeRelay.onSessionsChecked` — kept in its own module so
 * main/pokeTools.ts doesn't grow an unrelated responsibility. Extended for
 * Arceus v2 (docs/arceus-v2-plan.md §3.4) with a workspaces registry block
 * and each session's `lastDispatch`.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRecord } from '../shared/types';
import type { WorkspaceRecord } from '../shared/workspaceTypes';
import { log } from './diagnostics';

function arceusDir(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'agents', 'arceus');
}

/** Exported so `arceusPrompt.ts` can hand this same absolute path to the
 *  renderer alongside SYSTEM.md's — see that module's `ensureArceusSystemPrompt`. */
export function arceusRosterFilePath(harnessHomeDir: string): string {
  return join(arceusDir(harnessHomeDir), 'roster.json');
}

interface RosterFileEntry {
  title: string;
  pokemon: string;
  provider: string;
  status: string;
  workspace?: string;
  /** See `SessionRecord.lastDispatch`'s own comment — the continuity signal
   *  Arceus v2's dispatch flow (docs/arceus-v2-plan.md §3.1) reads to offer
   *  reuse-vs-spawn-fresh for an idle agent. */
  lastDispatch?: { at: number; message: string };
}

/** Arceus v2 (docs/arceus-v2-plan.md §3.4/§7 item 2) — the workspaces
 *  registry block, trimmed to just what Arceus needs: an id to name in
 *  `poke-spawn`, a human name, and the cwd that workspace resolves to.
 *  `createdAt`/`accent` (WorkspaceRecord's other fields) are UI-only and
 *  dropped here. */
interface RosterWorkspaceEntry {
  id: string;
  name: string;
  primaryFolder: string;
}

/** Serialized once per call purely to diff against the last WRITTEN
 *  contents — `lastChangedAt` (the on-disk field, named for what it actually
 *  tracks) is deliberately excluded from this comparison, so a
 *  `sessions:checkpoint` that carries no roster-relevant change (the common
 *  case — checkpoints fire on every selection change too) skips the write
 *  entirely. Keyed alongside the target `harnessHomeDir` (not just the
 *  entries) so a mid-run harness-home move (Settings' folder picker — see
 *  index.ts's `appSettings:saveSettings`) still gets a real write to the NEW
 *  location even when the roster content itself hasn't changed, instead of
 *  silently skipping and leaving that location without a roster.json at
 *  all. An `existsSync` check on the target path (cheap next to the
 *  `writeFileSync` it's avoiding) also forces a rewrite if the file is ever
 *  deleted out from under an otherwise-unchanged cache — the
 *  `arceus:ensureSystemPrompt` handler below relies on a call here actually
 *  guaranteeing the file exists. */
let lastWrittenPath: string | null = null;
let lastEntriesJson: string | null = null;

/** Called from `sessions:checkpoint` (main/index.ts), right next to
 *  `pokeRelay.onSessionsChecked` — and once more from the
 *  `arceus:ensureSystemPrompt` handler right before it hands `rosterPath`
 *  to the renderer, so the file is guaranteed to exist at the moment its
 *  path is promised to Arceus rather than depending on a checkpoint having
 *  already fired first. Arceus's own entry is excluded — same exclusion the
 *  renderer's `toRosterEntries` applies to the dispatch-box roster tag.
 *  Errors are logged, never thrown: a roster-file write must never take
 *  down a checkpoint.
 *
 *  `workspaces` (Arceus v2, docs/arceus-v2-plan.md §3.4) is the FULL live
 *  workspace registry, not filtered — every workspace is a valid
 *  `poke-spawn` target whether or not it currently has any sessions. */
export function writeArceusRosterFile(
  harnessHomeDir: string,
  sessions: SessionRecord[],
  workspaces: WorkspaceRecord[]
): void {
  const p = arceusRosterFilePath(harnessHomeDir);
  const entries: RosterFileEntry[] = sessions
    .filter((s) => !s.isArceus && !s.isPlainTerminal)
    .map((s) => ({
      title: s.title,
      pokemon: s.pokemon,
      provider: s.provider,
      status: s.status,
      workspace: s.workspaceId,
      lastDispatch: s.lastDispatch
    }));
  const workspaceEntries: RosterWorkspaceEntry[] = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    primaryFolder: w.primaryFolder
  }));

  // Compared together so a workspace-only change (created/renamed, no
  // session change at all) still triggers a rewrite instead of being
  // silently skipped by a comparison that only ever looked at `entries`.
  const combinedJson = JSON.stringify({ entries, workspaceEntries });
  if (p === lastWrittenPath && combinedJson === lastEntriesJson && existsSync(p)) return;

  try {
    mkdirSync(arceusDir(harnessHomeDir), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    // Named `lastChangedAt` rather than `generatedAt`: because the write
    // above is skipped when nothing roster-relevant changed, this timestamp
    // tracks the last real CHANGE, not the last time this function ran —
    // calling it `generatedAt` would read as "freshly polled" and could lead
    // Arceus to (wrongly) treat an old-looking timestamp as a stale file.
    const content = JSON.stringify(
      { lastChangedAt: new Date().toISOString(), workspaces: workspaceEntries, sessions: entries },
      null,
      2
    );
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, p);
    lastWrittenPath = p;
    lastEntriesJson = combinedJson;
  } catch (e) {
    log('arceus-roster', 'error', 'writing roster file failed', {
      error: e instanceof Error ? e.message : String(e)
    });
  }
}
