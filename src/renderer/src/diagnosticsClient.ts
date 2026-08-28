/**
 * Renderer-side helper for forwarding to main's diagnostics log (BACKLOG
 * item 1) — every renderer call site (window.onerror/unhandledrejection in
 * main.tsx, the invariant-counter snapshots in diagnosticsCounters.ts)
 * should go through this rather than calling `window.api.logDiagnostic`
 * directly.
 *
 * Why this needs its own wrapper rather than a bare `void
 * window.api.logDiagnostic(...)`: `ipcRenderer.invoke` structured-clones its
 * arguments BEFORE main ever sees them, so a circular `data` value (or one
 * whose `toJSON` throws) can reject the returned promise before main's own
 * swallow-everything `log()` gets a chance to degrade it. An unhandled
 * rejection from that promise would land right back in this app's own
 * `unhandledrejection` listener, which forwards it here again — a loop.
 * `.catch(() => {})` breaks that, and the outer try/catch covers the
 * structured-clone throwing synchronously instead. Keep `data` at every call
 * site to plain scalars/strings/plain objects — this is a safety net, not a
 * substitute for that discipline. */
import type { LogLevel } from '@shared/diagnosticsTypes';

export function safeLogDiagnostic(area: string, level: LogLevel, message: string, data?: unknown): void {
  try {
    window.api.logDiagnostic(area, level, message, data).catch(() => {
      /* main-side write already swallows its own errors — a rejected
         IPC round-trip itself (e.g. window tearing down) is not worth
         reacting to. */
    });
  } catch {
    /* structured-clone failure or the API being unavailable — logging must
       never itself throw. */
  }
}
