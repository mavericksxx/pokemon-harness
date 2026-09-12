/**
 * Arceus v2 ambient board (docs/arceus-v2-plan.md §3.6/§3.7) — "idle 12m" /
 * "blocked 34m" needs to know how long a session has held its CURRENT
 * status, and nothing on `SessionRecord` tracks that (only the timestamp of
 * its last DISPATCH, a different signal — see `lastDispatch`). Rather than
 * add a new field threaded through main/IPC/the roster file for a single
 * renderer-only display need, this tracks it purely client-side: a
 * module-level map, updated on every store change, recording when each
 * session's `status` was last OBSERVED to change.
 *
 * Seeded once at import time (so it's live from app boot, not just from the
 * first time the HUD board happens to render) and kept current by a plain
 * `useStore.subscribe` — this module has exactly one side effect (the
 * subscription below), fired once regardless of how many times
 * `statusSinceMs` itself is called.
 *
 * Caveat, worth knowing: a session's FIRST observation by this module (most
 * commonly: every session restored on app launch, all at once, before any of
 * them have had a real status transition since) has no history to recover —
 * this is the normal case on every boot, not an edge case. Seeding `since`
 * with `Date.now()` for that first sight would read as "just changed" for a
 * session that's actually been idle/blocked for a while; seeding it instead
 * with the latest of its creation time or its last dispatch (below) is a
 * truthful LOWER bound — never later than the real transition, so a shown
 * duration is never overstated, even though it can still understate one for
 * a session that's been idle a long time with no dispatch since it changed.
 */
import { useStore, type Session } from '@/store/store';

interface StatusRecord {
  status: Session['status'];
  since: number;
}

const statusSince = new Map<string, StatusRecord>();

function sync(sessions: Session[]): void {
  const liveIds = new Set<string>();
  for (const s of sessions) {
    liveIds.add(s.id);
    const rec = statusSince.get(s.id);
    if (!rec) {
      // First sight of this session (see this file's header) — best
      // available truthful lower bound, not "just changed."
      statusSince.set(s.id, { status: s.status, since: Math.max(s.createdAt, s.lastDispatch?.at ?? 0) });
    } else if (rec.status !== s.status) {
      // A real transition this module actually witnessed.
      statusSince.set(s.id, { status: s.status, since: Date.now() });
    }
  }
  for (const id of statusSince.keys()) {
    if (!liveIds.has(id)) statusSince.delete(id);
  }
}

sync(useStore.getState().sessions);
useStore.subscribe((state) => sync(state.sessions));

/** Milliseconds since `session.id` last entered its CURRENT `status` — 0 if
 *  this module has never observed that session at all (brand new). */
export function statusSinceMs(session: Pick<Session, 'id' | 'status'>): number {
  const rec = statusSince.get(session.id);
  if (!rec || rec.status !== session.status) return 0;
  return Math.max(0, Date.now() - rec.since);
}
