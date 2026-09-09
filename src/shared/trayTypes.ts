/** Wire shape for the macOS menu-bar (Tray) popover — GitHub issue #17.
 *  The popover is its own lightweight `BrowserWindow` (NOT the main
 *  renderer's React app — see tray.ts's own header), so it gets its own
 *  narrow IPC contract rather than reusing the main renderer's channels. */

import type { UsageSnapshot } from './usageTypes';
import type { CostHistorySnapshot } from './costHistoryTypes';

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

export interface TrayPopoverData {
  usage: UsageSnapshot;
  costHistory: CostHistorySnapshot;
  sessions: TraySessionCounts;
}
