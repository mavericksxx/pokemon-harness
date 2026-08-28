import type { Session } from '@/store/store';
import { statusLabel } from './statusLabel';

/**
 * Display text for a session's status badge, napping-aware (Phase 8.5 Wave B
 * items 3/4). Deliberately a NEW file rather than a change to
 * `statusLabel.ts` itself: `napping` is an additive `SessionRecord` field,
 * not a `SessionStatus` value (see that field's own comment in
 * shared/types.ts), so the two-line "swap the label" rule lives alongside
 * `statusLabel` instead of inside it — `statusLabel.ts` stays exactly the
 * single-purpose status→copy map it already is.
 */
export function sessionStatusLabel(session: Session): string {
  return session.napping ? 'napping' : statusLabel(session.status);
}
