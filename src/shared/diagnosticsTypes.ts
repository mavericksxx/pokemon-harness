/** Types shared between main, preload and renderer for local-only
 *  diagnostics (BACKLOG item 1) — a structured JSONL log written to
 *  `<harness home>/logs/harness.log` (see main/diagnostics.ts) plus a small
 *  info blob for the Settings panel's "diagnostics" row. Nothing here ever
 *  leaves the machine — no network I/O, no telemetry service. */

export type LogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticsInfo {
  appVersion: string;
  electronVersion: string;
  /** Null only in the pathological case where even the lazy mkdir on first
   *  write has failed — see main/diagnostics.ts's `getLogDir`. */
  logDir: string | null;
  /** Errors logged (level 'error') since this process started — main- and
   *  renderer-originated alike, since renderer errors are forwarded here
   *  over IPC and logged through the same `log()` call. */
  recentErrorCount: number;
}
