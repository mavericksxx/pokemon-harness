/**
 * HARNESS.md — the harness's own instructions file, `<harnessHomeDir>/
 * HARNESS.md` (see harnessHome.ts; that module already ensures
 * `harnessHomeDir` itself exists before either call below runs). Unlike
 * arceusPrompt.ts's `ensureArceusSystemPrompt` (seeded once, never
 * overwritten), this one re-seeds from the template whenever the app version
 * that last wrote it doesn't match the running app version — otherwise a
 * shipped instruction update would never reach an existing install, since
 * HARNESS.md is written once at first boot and then left alone forever. The
 * stamp lives in a sidecar file, `HARNESS.version`, next to HARNESS.md,
 * holding the plain `app.getVersion()` string that wrote it. Within a single
 * app version, a user's edits to HARNESS.md are still the live source of
 * truth (nothing here touches the file again until the version changes).
 * Delivered into every claude/codex session's argv by pty.ts's spawn() — see
 * that file's own comment for the exact mechanism per provider.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_INSTRUCTIONS_TEMPLATE } from '../shared/harnessInstructions';

export function harnessInstructionsPath(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'HARNESS.md');
}

function harnessInstructionsVersionPath(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'HARNESS.version');
}

/** (Re-)seeds HARNESS.md from the template when it's missing, or when the
 *  stamped version in its `HARNESS.version` sidecar doesn't match
 *  `appVersion` — a missing/unreadable stamp (an install from before this
 *  versioning existed, or a user-deleted sidecar) counts as "doesn't match",
 *  so an upgrading install still gets refreshed once. Called once at boot
 *  (right after `ensureHarnessHome`) and again whenever the harness home dir
 *  changes at runtime (main/index.ts) — the same two call sites
 *  `ensureHarnessHome` itself has. */
export async function ensureHarnessInstructions(
  harnessHomeDir: string,
  appVersion: string
): Promise<{ path: string }> {
  const p = harnessInstructionsPath(harnessHomeDir);
  const versionPath = harnessInstructionsVersionPath(harnessHomeDir);
  let stampedVersion: string | null = null;
  try {
    stampedVersion = (await readFile(versionPath, 'utf8')).trim();
  } catch {
    /* missing/unreadable stamp — treated as "doesn't match" below */
  }
  if (!existsSync(p) || stampedVersion !== appVersion) {
    await writeFile(p, HARNESS_INSTRUCTIONS_TEMPLATE, 'utf8');
    await writeFile(versionPath, appVersion, 'utf8');
  }
  return { path: p };
}
