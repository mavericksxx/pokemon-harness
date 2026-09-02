/**
 * HARNESS.md — the harness's own instructions file, `<harnessHomeDir>/
 * HARNESS.md` (see harnessHome.ts; that module already ensures
 * `harnessHomeDir` itself exists before either call below runs). Follows
 * arceusPrompt.ts's `ensureArceusSystemPrompt` exactly: seeded from the
 * template ONLY if the file doesn't already exist, never overwritten after
 * that, so a user's edits to it are the live source of truth. Delivered into
 * every claude/codex session's argv by pty.ts's spawn() — see that file's
 * own comment for the exact mechanism per provider.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_INSTRUCTIONS_TEMPLATE } from '../shared/harnessInstructions';

export function harnessInstructionsPath(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'HARNESS.md');
}

/** Seeds HARNESS.md from the template on first call only. Called once at
 *  boot (right after `ensureHarnessHome`) and again whenever the harness
 *  home dir changes at runtime (main/index.ts) — the same two call sites
 *  `ensureHarnessHome` itself has. */
export async function ensureHarnessInstructions(harnessHomeDir: string): Promise<{ path: string }> {
  const p = harnessInstructionsPath(harnessHomeDir);
  if (!existsSync(p)) {
    await writeFile(p, HARNESS_INSTRUCTIONS_TEMPLATE, 'utf8');
  }
  return { path: p };
}
