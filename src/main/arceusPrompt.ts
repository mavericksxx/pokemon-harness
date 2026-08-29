/**
 * Arceus's system prompt file (Phase 8.8 §2) — `agents/arceus/SYSTEM.md` in
 * the harness home directory (see harnessHome.ts; that module already
 * creates the empty `agents/` dir it lives under). Written ONCE, from the
 * user-approved template (shared/arceus.ts), the first time Arceus is ever
 * summoned — never overwritten after, so the user can retune him by editing
 * the FILE, not code. Every summon re-reads it fresh; nothing here caches
 * the contents across calls.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCEUS_SYSTEM_PROMPT_TEMPLATE } from '../shared/arceus';
import { arceusRosterFilePath } from './arceusRosterFile';

function arceusDir(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'agents', 'arceus');
}

function arceusSystemPromptPath(harnessHomeDir: string): string {
  return join(arceusDir(harnessHomeDir), 'SYSTEM.md');
}

/** Ensures the file exists (seeding it from the template on first call
 *  only) and returns its CURRENT on-disk contents plus its path — called
 *  fresh on every summon (see arceus.ts's renderer-side `summonArceus`),
 *  so a user's edit to the file takes effect the very next time Arceus is
 *  summoned, no app restart needed. Also hands back the absolute path to
 *  the live roster file (arceusRosterFile.ts) — piggybacked on this same
 *  IPC round-trip rather than a new channel, since `summonArceus` already
 *  calls this once per fresh summon and needs both paths at the same
 *  moment, to build the first prompt (shared/arceus.ts's
 *  `buildArceusFirstPrompt`). */
export async function ensureArceusSystemPrompt(
  harnessHomeDir: string
): Promise<{ path: string; prompt: string; rosterPath: string }> {
  await mkdir(arceusDir(harnessHomeDir), { recursive: true });
  const p = arceusSystemPromptPath(harnessHomeDir);
  if (!existsSync(p)) {
    await writeFile(p, ARCEUS_SYSTEM_PROMPT_TEMPLATE, 'utf8');
  }
  const prompt = await readFile(p, 'utf8');
  return { path: p, prompt, rosterPath: arceusRosterFilePath(harnessHomeDir) };
}
