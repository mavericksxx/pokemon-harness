/**
 * The harness home directory (Phase 8.7) — a user-visible folder for
 * agent-facing files, distinct from Electron's userData (caches,
 * sessions.json, app-settings.json stay exactly where they were; this is
 * NOT a replacement for that). Default `~/PokemonHarness`, overridable via
 * `AppSettings.harnessHomeDir` (see appSettingsTypes.ts) and the Settings
 * panel's folder picker.
 *
 * This phase's contents: `workspaces.json` (workspacePersistence.ts) and an
 * empty `agents/` directory, reserved for Phase 8.8/8.9's Arceus memory/
 * inboxes — created and documented here, but nothing is written into it yet.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '../shared/appSettingsTypes';

export function defaultHarnessHomeDir(): string {
  return join(homedir(), 'PokemonHarness');
}

/** `settings.harnessHomeDir` is the override (null = use the default) — the
 *  one place that resolves it, so every caller (boot, a settings save, the
 *  Settings panel's path display) agrees on the same value. */
export function resolveHarnessHomeDir(settings: Pick<AppSettings, 'harnessHomeDir'>): string {
  return settings.harnessHomeDir?.trim() || defaultHarnessHomeDir();
}

const README = `# Pokemon Harness

This is the harness's town hall — the one folder on disk it keeps for you
(and for your agents) outside of Electron's own app-data cache.

## What lives here

- \`workspaces.json\` — your workspaces (named playgrounds, each with its own
  garden and its own sessions). The app manages this file; you shouldn't
  need to touch it by hand.
- \`agents/\` — reserved for a future phase (per-agent memory and inboxes).
  Empty for now.

## Moving this folder

You can point the harness at a different home folder from Settings. Doing so
only changes where it writes NEXT — it won't move anything already sitting
here. If you want your workspaces to follow, copy \`workspaces.json\` (and
\`agents/\`) over yourself.
`;

/** Idempotent — creates the folder, its `agents/` subfolder, and the
 *  README (only if the README doesn't already exist, so a user's own edits
 *  to it are never clobbered on a later launch). Call once at boot, and
 *  again whenever the setting changes. */
export async function ensureHarnessHome(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'agents'), { recursive: true });
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    await writeFile(readmePath, README, 'utf8');
  }
}
