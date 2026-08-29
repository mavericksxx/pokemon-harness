/**
 * "Export diagnostics bundle" (BACKLOG friend-testing readiness) — packages
 * the tail of harness.log, app/Electron/Chrome/Node/macOS version info, and
 * a redacted copy of app-settings into a single zip a non-technical tester
 * can attach to a bug report.
 *
 * No new dependency: package.json has no zip library, and a hand-rolled zip
 * writer (CRC32 + central directory bit-twiddling) is a lot of surface for a
 * one-button feature. macOS ships Info-Zip's `zip` CLI at `/usr/bin/zip`, and
 * usageService.ts already shells out to a system binary (`security`) the
 * same way — see that file's `execFileAsync` import for the precedent. This
 * app only ships for macOS (package.json's `build.mac`), so that's a safe
 * assumption here.
 *
 * Redaction: every `log()`/`safeLogDiagnostic()` call site in this codebase
 * was traced by hand for this feature — none of them ever log OAuth/
 * credential material, only error MESSAGES (usageService.ts's own fetch-
 * failure logs are the closest thing, and those log `e.message`, never the
 * token itself). The one thing worth stripping here is the user's home
 * directory path, which shows up in `recentFolders`/`harnessHomeDir` and in
 * pty spawn-failure log lines (main/pty.ts) as an absolute path — swapped
 * for `~` in both the log tail and the settings JSON below.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { getLogFilePath } from './diagnostics';
import type { AppSettings } from '../shared/appSettingsTypes';

const execFileAsync = promisify(execFile);

/** Last ~2MB of harness.log, tail not whole file — diagnostics.ts's rotation
 *  size (MAX_BYTES, 20MB) was deliberately raised above this so a rotation
 *  right before a crash doesn't leave the tail nearly empty for the exact
 *  session that had the bug. */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** Cheap, best-effort scrub: the user's own home directory is the one thing
 *  in the log/settings that can read as PII (folder/project names via
 *  `recentFolders`, `harnessHomeDir`, pty `cwd`) — swap every occurrence for
 *  `~`. Not a general secret-redactor; see this file's header for why no
 *  secret material reaches this bundle in the first place. */
function redactHomePaths(text: string): string {
  const home = homedir();
  return home ? text.split(home).join('~') : text;
}

async function readLogTail(): Promise<string> {
  const logPath = getLogFilePath();
  if (!logPath || !existsSync(logPath)) return '(no harness.log yet)';
  try {
    const { size } = await stat(logPath);
    if (size === 0) return '(harness.log is empty)';
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const length = size - start;
    const fh = await open(logPath, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch (e) {
    return `(failed to read harness.log: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/** `sw_vers` ships on every macOS install; `os.release()` (Darwin kernel
 *  version, e.g. "23.6.0") is only a fallback for the pathological case
 *  where it's somehow unavailable. */
async function getMacOSVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return `darwin ${release()}`;
  }
}

/** Default filename for the save dialog — `pokeharness-diagnostics-
 *  YYYYMMDD-HHMM.zip`, local time (a tester's own clock, not UTC, since
 *  that's what they'd expect matching "just now"). */
export function defaultBundleFilename(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `pokeharness-diagnostics-${stamp}.zip`;
}

/** Builds the bundle and writes it to `destZipPath` (already zip already
 *  chosen by the caller's save dialog). Throws on failure — the caller
 *  (main/index.ts's `diagnostics:exportBundle` handler) is responsible for
 *  catching and logging. */
export async function buildDiagnosticsBundle(destZipPath: string, settings: AppSettings): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'pokeharness-diagnostics-'));
  try {
    const [logTail, macOSVersion] = await Promise.all([readLogTail(), getMacOSVersion()]);
    const systemInfo = [
      `generated: ${new Date().toISOString()}`,
      `app version: ${app.getVersion()}`,
      `electron: ${process.versions.electron}`,
      `chrome: ${process.versions.chrome}`,
      `node: ${process.versions.node}`,
      `macOS: ${macOSVersion}`
    ].join('\n');
    const redactedSettings = redactHomePaths(JSON.stringify(settings, null, 2));

    const logTailPath = join(staging, 'harness-log-tail.txt');
    const systemInfoPath = join(staging, 'system-info.txt');
    const settingsPath = join(staging, 'app-settings.redacted.json');
    await Promise.all([
      writeFile(logTailPath, redactHomePaths(logTail), 'utf8'),
      writeFile(systemInfoPath, systemInfo, 'utf8'),
      writeFile(settingsPath, redactedSettings, 'utf8')
    ]);

    // `zip` UPDATES an existing archive rather than replacing it outright —
    // if the tester is re-saving over a previous export, drop the old file
    // first so the result is always exactly these three members.
    if (existsSync(destZipPath)) await rm(destZipPath, { force: true });
    await execFileAsync('zip', ['-j', '-q', destZipPath, logTailPath, systemInfoPath, settingsPath]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
