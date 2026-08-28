import type { SessionStatus } from '@shared/types';

/**
 * Display text for a status badge — design spec §F5: short, warm, lowercase
 * copy. `SessionStatus` itself stays as-is (`'blocked'` etc. — main/index.ts,
 * ptyParser and friends all key off the literal value); this only renames
 * what the badge SHOWS the user, same pattern as `AgentRosterCard`'s
 * existing "waiting on you" tool-text override for the same status.
 */
export function statusLabel(status: SessionStatus): string {
  return status === 'blocked' ? 'needs you' : status;
}
