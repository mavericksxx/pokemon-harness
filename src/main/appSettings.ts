/**
 * General app settings (theme, auto-permission-mode per provider, keep-awake,
 * recent folders — parity sweep), persisted as a plain JSON file under
 * userData. Mirrors `audioSettings.ts`'s shape exactly (see that file's
 * header for why a plain JSON file rather than a new dependency).
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../shared/appSettingsTypes';

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json');
}

export async function loadAppSettings(): Promise<AppSettings> {
  const p = settingsPath();
  if (!existsSync(p)) return { ...DEFAULT_APP_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<AppSettings>;
    // Merge over defaults so an older settings file missing a newly-added key
    // doesn't produce `undefined` for it.
    return { ...DEFAULT_APP_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  const p = settingsPath();
  await mkdir(join(app.getPath('userData')), { recursive: true });
  await writeFile(p, JSON.stringify(settings));
}
