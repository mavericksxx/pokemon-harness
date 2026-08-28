/**
 * Arceus's summon config disk persistence (Phase 8.9) —
 * `agents/arceus/summon.json` in the harness home directory (see
 * harnessHome.ts / arceusPrompt.ts, which puts SYSTEM.md in the same
 * `agents/arceus/` dir). Same atomic tmp+rename write as
 * workspacePersistence.ts, written synchronously on the rare, user-driven
 * moment it changes (the first summon, or a Settings reset) rather than
 * debounced.
 *
 * This file's mere existence is the "summon-once" gate: present means
 * Arceus has been onboarded before, so every later launch auto-summons him
 * from its contents with no dialog; absent means first-run (or the user
 * wiped it via Settings), so the setup dialog is shown instead. See
 * SummonArceusButton.tsx and main.tsx's boot().
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArceusSummonConfig } from '../shared/arceus';

function arceusDir(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'agents', 'arceus');
}

function summonConfigPath(harnessHomeDir: string): string {
  return join(arceusDir(harnessHomeDir), 'summon.json');
}

/** Null if never summoned, or the saved file is missing/corrupt — both
 *  treated as "first run" by the caller, same as workspacePersistence.ts's
 *  corrupt-registry handling. */
export async function loadArceusSummonConfig(harnessHomeDir: string): Promise<ArceusSummonConfig | null> {
  const p = summonConfigPath(harnessHomeDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<ArceusSummonConfig>;
    if (!raw.cwd || typeof raw.cwd !== 'string') return null;
    return { cwd: raw.cwd, model: raw.model, autoMode: !!raw.autoMode };
  } catch {
    return null;
  }
}

/** Atomic (tmp+rename) synchronous write — same shape as
 *  saveWorkspaceRegistry() in workspacePersistence.ts. */
export function saveArceusSummonConfig(harnessHomeDir: string, config: ArceusSummonConfig): void {
  try {
    mkdirSync(arceusDir(harnessHomeDir), { recursive: true });
    const p = summonConfigPath(harnessHomeDir);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(config), 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    console.error('[arceus] persisting summon config failed:', e);
  }
}

/** Returns the app to first-run behavior (Settings' "reset arceus" action,
 *  or a user manually deleting the file) — best-effort; a missing file is
 *  already the desired end state, not an error. */
export async function resetArceusSummonConfig(harnessHomeDir: string): Promise<void> {
  try {
    await unlink(summonConfigPath(harnessHomeDir));
  } catch {
    /* already gone — fine */
  }
}
