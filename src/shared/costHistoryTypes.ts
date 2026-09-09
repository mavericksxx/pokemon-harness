/** Types for the tray popover's cost-history section (GitHub issue #17's
 *  locked-in scope addition — see the issue's design-decision comment).
 *  Computed entirely in main (src/main/costHistoryScan.ts, run as a
 *  detached helper process by src/main/costHistory.ts) from a one-time scan
 *  of every `~/.claude/projects/**\/*.jsonl` transcript modified in the last
 *  `lookbackDays` — NOT the live, currently-registered-session tracking
 *  costWatcher.ts already does (see that file's header for the distinction).
 *  This file is just the wire shape, same pattern as costTypes.ts. */

/** One calendar day's total cost — local time, `YYYY-MM-DD`. Every day in
 *  the lookback window is present, zero-filled, oldest first, so the
 *  popover's sparkline never has to reason about gaps. */
export interface CostHistoryDay {
  date: string;
  costUsd: number;
}

export interface CostHistoryTopModel {
  model: string;
  /** Total tokens (input + cache + output) attributed to this model across
   *  the whole lookback window — the ranking metric ("top model by token
   *  volume", per the issue's locked-in scope). */
  tokens: number;
}

export interface CostHistorySnapshot {
  /** Epoch ms this snapshot was actually computed (not when it was read from
   *  cache) — for a possible "as of" readout, same convention as
   *  UsageSnapshot.updatedAt. */
  generatedAt: number;
  /** Oldest to newest, always exactly `lookbackDays` entries. */
  days: CostHistoryDay[];
  todayCostUsd: number;
  /** Sum of every `days[].costUsd`. */
  last30dCostUsd: number;
  /** Total tokens (input + cache + output) of the single most recent
   *  assistant turn across every scanned transcript — null when the scan
   *  found no assistant turns at all in the window. */
  latestTurnTokens: number | null;
  /** Total tokens (input + cache + output) across every assistant turn in
   *  the window. */
  last30dTokens: number;
  /** Highest-token-volume model over the window, or null when nothing was
   *  scanned. */
  topModel: CostHistoryTopModel | null;
}
