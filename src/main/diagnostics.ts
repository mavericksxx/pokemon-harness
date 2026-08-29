/**
 * Local-only diagnostics logger (BACKLOG item 1) — line-oriented JSONL at
 * `<harness home>/logs/harness.log` (harness home resolution lives in
 * harnessHome.ts). Nothing here ever touches the network: this is a plain
 * file on disk, for the user's own eyes (or a future bug report), not
 * telemetry.
 *
 * Ground rules the rest of this file exists to uphold:
 *  - a logging failure must NEVER crash or block the app — every failure
 *    mode here is swallowed, after a best-effort console fallback so the
 *    failure is still visible during dev.
 *  - writes are synchronous (`appendFileSync`) and cheap: this app logs at
 *    most a few times a second even during an active hook/battle burst, so a
 *    stream + async queue would be complexity this doesn't need.
 *  - size-based rotation keeps at most 3 files on disk (harness.log, .1, .2)
 *    so the log can never grow unbounded.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../shared/diagnosticsTypes';

// Friend-testing readiness: bumped from 2MB to 20MB. The export bundle
// (main/diagnosticsExport.ts) ships the last ~2MB of harness.log — at the
// old 2MB rotation size, a rotation right before a crash could leave the
// live file nearly empty and the bundle would miss the very session the
// bug happened in. 20MB keeps that tail meaningfully non-empty in the
// common case; worst case on disk is 60MB across the 3 kept files, which is
// fine for a week of beta testing.
const MAX_BYTES = 20 * 1024 * 1024;
/** Total files kept: harness.log (current) + .1 + .2. */
const MAX_FILES = 3;

/** Set by `initDiagnostics`; deliberately NOT created on disk until the
 *  first actual write (see `log`'s lazy `mkdirSync`) — a user with a custom
 *  harness home shouldn't get a stray `logs/` folder just because this
 *  module was imported. */
let logDir: string | null = null;
let logFile: string | null = null;

/** Errors logged (level 'error') this process — the Settings panel's
 *  "recent errors" count (see appSettings:getDiagnosticsInfo in index.ts). */
let recentErrorCount = 0;

/** Diagnostics opt-in (BACKLOG friend-testing readiness) — default true, set
 *  from `appSettings.diagnosticsLoggingEnabled` at boot and on every save
 *  (main/index.ts). Gates non-error verbosity only: `log()` below always
 *  writes `level: 'error'` entries regardless of this flag — errors are
 *  cheap and losing them defeats the point of a bug-report log. Off just
 *  stops the routine chatter (counters snapshots, battle-spawn events,
 *  divergence warnings, etc.) from filling the file during a week of
 *  testing. Never gates the log file/directory's existence — see
 *  `ensureLogDir` in main/index.ts's `whenReady`, which is unconditional. */
let loggingEnabled = true;

export function setDiagnosticsLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled;
}

/** Point future writes at `<harnessHomeDir>/logs` — call once at boot, and
 *  again whenever the harness home directory setting changes (same pattern
 *  harnessHome.ts's own `ensureHarnessHome` follows: this only affects
 *  FUTURE writes, nothing already on disk moves). Pure bookkeeping, no I/O —
 *  the directory itself is created lazily on first write. */
export function initDiagnostics(harnessHomeDir: string): void {
  logDir = join(harnessHomeDir, 'logs');
  logFile = join(logDir, 'harness.log');
}

/** Current resolved logs directory, for the Settings panel's path display
 *  and its "open logs" button. Null only if `initDiagnostics` was never
 *  called (shouldn't happen — see index.ts). */
export function getLogDir(): string | null {
  return logDir;
}

/** Current resolved harness.log path — export bundle's tail-read
 *  (main/diagnosticsExport.ts). Null under the same conditions as
 *  `getLogDir`. */
export function getLogFilePath(): string | null {
  return logFile;
}

export function getRecentErrorCount(): number {
  return recentErrorCount;
}

function mirrorToConsole(level: LogLevel, area: string, message: string, data?: unknown): void {
  const line = `[${area}] ${message}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
}

/** Rotate harness.log -> .1 -> .2, dropping whatever was in .2. Called from
 *  inside `log`'s own try/catch, so any failure here (a locked file, a
 *  permissions error) is swallowed the same as any other write failure. */
function rotate(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  const oldest = `${file}.${MAX_FILES - 1}`;
  if (existsSync(oldest)) rmSync(oldest);
  for (let i = MAX_FILES - 2; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
}

/** JSON.stringify that degrades instead of throwing — a circular reference,
 *  a BigInt, or a `data` value with a throwing `toJSON()` must never take
 *  down logging itself (or the app, since a logger error would otherwise
 *  propagate straight out of `log`). */
function serializeEntry(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry);
  } catch {
    try {
      return JSON.stringify({ ...entry, data: '[unserializable]' });
    } catch {
      return JSON.stringify({ ts: entry.ts, level: 'warn', area: 'diagnostics', message: 'log entry serialization failed' });
    }
  }
}

/** Append one JSONL line: `{ts, level, area, message, data?}`. Always
 *  mirrors to the console first (so the message is visible even if the file
 *  write below fails, or before `initDiagnostics` has ever run) — the file
 *  write itself is best-effort and never throws out of this function. */
export function log(area: string, level: LogLevel, message: string, data?: unknown): void {
  if (level === 'error') recentErrorCount++;
  mirrorToConsole(level, area, message, data);
  // Opt-in gate: errors always get written; everything else is skipped
  // while the user has turned diagnostics logging off (see `loggingEnabled`
  // doc comment above).
  if (!loggingEnabled && level !== 'error') return;
  try {
    if (!logDir || !logFile) return; // initDiagnostics hasn't run yet — console mirror above is all we can do
    let size = 0;
    try {
      size = statSync(logFile).size;
    } catch {
      size = 0; // doesn't exist yet — nothing to rotate
    }
    if (size >= MAX_BYTES) rotate(logDir, logFile);
    else mkdirSync(logDir, { recursive: true }); // first write ever — lazy-create the folder
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, area, message };
    if (data !== undefined) entry.data = data;
    appendFileSync(logFile, serializeEntry(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[diagnostics] write failed:', e);
  }
}
