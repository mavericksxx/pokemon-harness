/**
 * Shared atomic JSON writer for the settings files that used to `writeFile`
 * straight to their final path (appSettings.ts, audioSettings.ts,
 * terminalSettings.ts) — a crash mid-write left a truncated/corrupt file for
 * the next `loadX` to choke on. Same tmp+rename shape as the existing
 * atomic writers (sessionPersistence.ts, workspacePersistence.ts,
 * arceusSummonConfig.ts, arceusRosterFile.ts), just factored out as one
 * async helper for the three settings files, which already use the async
 * `node:fs/promises` API those sync writers don't.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, path);
}
