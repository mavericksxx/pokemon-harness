/**
 * Session registry disk persistence (Phase 8.5 #1) — the in-memory
 * `sessionRegistry` mirror in main/index.ts (checkpointed from the renderer
 * on every store change, used to re-adopt sessions after a renderer crash)
 * additionally lands here, debounced, so sessions also survive a full app
 * quit/relaunch and not just a renderer crash/reload.
 *
 * Same userData-JSON shape as audioSettings.ts's existing precedent, plus an
 * atomic tmp+rename write: this file is written on a short debounce while
 * the app is live, so a crash mid-write must never leave a corrupt/
 * truncated registry behind for the next launch to choke on.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from '../shared/types';

export interface PersistedSessions {
  sessions: SessionRecord[];
  lastSelectedId: string | null;
}

const EMPTY: PersistedSessions = { sessions: [], lastSelectedId: null };

/** Coalesce a burst of rapid checkpoints (e.g. several tool calls back to
 *  back) into one disk write instead of one per change. */
const PERSIST_DEBOUNCE_MS = 1000;

function sessionsFilePath(userDataDir: string): string {
  return join(userDataDir, 'sessions.json');
}

export async function loadPersistedSessions(userDataDir: string): Promise<PersistedSessions> {
  const p = sessionsFilePath(userDataDir);
  if (!existsSync(p)) return EMPTY;
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<PersistedSessions>;
    if (!Array.isArray(raw.sessions)) return EMPTY;
    return { sessions: raw.sessions, lastSelectedId: raw.lastSelectedId ?? null };
  } catch {
    // Corrupt/truncated file — never let a bad registry block boot. The
    // atomic write below is what keeps this rare in practice.
    return EMPTY;
  }
}

/** Debounced, atomic (tmp+rename) writer for the session registry. One
 *  instance owns the pending-timer state, the same way main/index.ts owns
 *  `ptyManager`/`hookBridge` as singletons. */
export class SessionPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PersistedSessions | null = null;
  /** Set only by `flushEmpty()` — once true, `schedule()`/`flush()` become
   *  permanent no-ops. See that method's own comment for why. */
  private sealed = false;

  constructor(private readonly userDataDir: string) {}

  /** Schedule a debounced write. Call on every checkpoint. */
  schedule(state: PersistedSessions): void {
    if (this.sealed) return;
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), PERSIST_DEBOUNCE_MS);
  }

  /** Write immediately (synchronously) and cancel any pending debounce.
   *  Call at `before-quit`, BEFORE killing any ptys: killing a pty fires its
   *  exit handler synchronously-enough-to-matter, which flips that session
   *  to `status: 'done'` and re-checkpoints — flushing after would persist a
   *  registry where every session looks like it finished on its own, not
   *  that the app quit out from under it. */
  flush(): void {
    if (this.sealed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const state = this.pending;
    this.pending = null;
    this.writeNow(state);
  }

  /** Force-write an empty registry immediately, discarding any pending
   *  debounced write, then SEALS this instance so nothing written after
   *  this point can ever land on disk. Used by Settings' "clear garden &
   *  quit" danger action: unlike `flush()`, this must win even if something
   *  re-checkpointed a non-empty state after the last `schedule()` call —
   *  the whole point is that the next launch finds nothing to resume. Call
   *  AFTER killing all ptys, so no exit-handler checkpoint can win a race
   *  against this write — but killing ptys is asynchronous-enough that one
   *  can still fire its exit handler AFTER this call returns (before
   *  `app.quit()` actually tears the process down), and `before-quit`'s own
   *  finalization block always calls `flush()` once more regardless of which
   *  quit path ran. Without sealing, that late `schedule()` would repopulate
   *  `pending`, and the routine `flush()` right after would dutifully write
   *  it — quietly undoing the wipe this method exists to guarantee. */
  flushEmpty(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.writeNow(EMPTY);
    this.sealed = true;
  }

  private writeNow(state: PersistedSessions): void {
    try {
      mkdirSync(this.userDataDir, { recursive: true });
      const p = sessionsFilePath(this.userDataDir);
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, p);
    } catch (e) {
      console.error('[sessions] persisting registry failed:', e);
    }
  }
}
