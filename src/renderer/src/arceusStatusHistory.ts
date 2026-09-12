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
 * Caveat, worth knowing: a session whose status was already sitting at its
 * current value before this module first loaded (practically: before
 * GardenScene ever mounted, i.e. essentially never in a normal app session)
 * reads as "just changed" the first time it's observed — there's no
 * historical record to recover for that case.
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
    if (!rec || rec.status !== s.status) {
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
