/** Shared types for the macOS menu-bar (Tray) native menu — GitHub issue #17.
 *  Originally also carried a `TrayPopoverData` wire shape for a
 *  `BrowserWindow`-based popover's IPC contract; that popover is gone (see
 *  tray.ts's own header for why — it couldn't draw over another app's
 *  native-fullscreen Space) and its data is now read synchronously
 *  in-process (tray.ts's `buildTemplate`) rather than assembled into one
 *  object and pushed over IPC, so that shape went with it. Only the
 *  session-count bucket type below is still shared (tray.ts's own
 *  `countSessions` produces it; nothing else needs a named type for
 *  usage/cost data since each is read straight from its own service). */

/** Session-status baseline (issue #17's agreed baseline scope) — bucketed
 *  from `SessionRecord.status` (shared/types.ts). `'done'` sessions are
 *  excluded from every bucket: they're finished, not a currently-active
 *  agent to report on. `'starting'` counts as idle (not yet working, not
 *  blocked). */
export interface TraySessionCounts {
  working: number;
  idle: number;
  needsYou: number;
}
