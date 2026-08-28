/**
 * Shared idle-queue + pty-injection helper (BACKLOG phase E) — extracted
 * from main/arceusRelay.ts's original hand-rolled per-target `Map` so focus
 * mode's queue composer can reuse the exact same safety rail instead of
 * re-implementing it: never write into a session's pty unless it's genuinely
 * idle (a permission prompt must never get auto-answered), queue the payload
 * otherwise, and deliver it (FIFO) the moment that session next goes idle —
 * dropping the queue outright once the session closes or finishes.
 *
 * Dependency-free (no node/electron imports — same "shared wire shape"
 * convention as costTypes.ts/audioTypes.ts) so one instance can live
 * main-side (arceusRelay.ts, writing synchronously via ptyManager.write) and
 * a second, independent instance can live renderer-side (focus mode's
 * composer, writing over the async `window.api.writePty` IPC bridge —
 * src/renderer/src/pty/focusQueue.ts) without duplicating the queueing logic
 * itself — only the `writePty` callback, `toPayload`, and the logging/UI
 * hooks differ per caller.
 *
 * Generic over the queued item type `T` (plain `string` for arceusRelay,
 * `{ text, payload }` for focus mode, whose composer chips need to show the
 * original human-readable text while injecting the bracketed-paste-wrapped
 * bytes) — `toPayload` is how the queue turns one `T` into the exact string
 * written to the pty.
 */
import type { PtyResult, SessionRecord } from './types';

export interface InjectionQueueHooks<T> {
  /** A payload was actually written to `target`'s pty (the write may still
   *  have failed — see `res.ok`; the caller decides how to log/report it). */
  onDeliver?: (target: SessionRecord, item: T, res: PtyResult) => void;
  /** The oldest queued item for `targetId` was dropped to stay under
   *  `maxPerTarget`. */
  onDropOldest?: (targetId: string, dropped: T) => void;
  /** Fires whenever `targetId`'s queued list changes shape — an item was
   *  queued, delivered, dropped (oldest-drop, target gone, or target done),
   *  or removed. Not needed by arceusRelay (nothing renders its queue); a UI
   *  (focus composer's chips) uses this to know when to re-`peek()`. */
  onChange?: (targetId: string) => void;
}

export class InjectionQueue<T = string> {
  private queue = new Map<string, T[]>();

  constructor(
    private writePty: (id: string, data: string) => PtyResult | Promise<PtyResult>,
    private maxPerTarget: number,
    private toPayload: (item: T) => string,
    private hooks: InjectionQueueHooks<T> = {}
  ) {}

  /** Injects `item` immediately if `target` is idle; otherwise queues it
   *  (FIFO, capped at `maxPerTarget` — oldest dropped first) for delivery
   *  once `flush` next sees `target` idle. Returns which happened, so a
   *  caller that wants to log the queued case with its own extra context
   *  (e.g. arceusRelay.ts's directive `agent` field) can do so at the call
   *  site rather than through a hook. */
  submit(target: SessionRecord, item: T): 'sent' | 'queued' {
    if (target.status === 'idle') {
      this.inject(target, item);
      return 'sent';
    }
    const q = this.queue.get(target.id) ?? [];
    if (q.length >= this.maxPerTarget) {
      const dropped = q.shift();
      if (dropped !== undefined) this.hooks.onDropOldest?.(target.id, dropped);
    }
    q.push(item);
    this.queue.set(target.id, q);
    this.hooks.onChange?.(target.id);
    return 'queued';
  }

  /** Delivers any queued items (FIFO) for a target that's now idle; drops a
   *  target's queue outright once it's gone from `sessions` (closed) or
   *  'done' (its pty is dead). Call on every session-list update. */
  flush(sessions: SessionRecord[]): void {
    if (this.queue.size === 0) return;
    for (const id of [...this.queue.keys()]) {
      const session = sessions.find((s) => s.id === id);
      if (!session || session.status === 'done') {
        this.queue.delete(id);
        this.hooks.onChange?.(id);
        continue;
      }
      if (session.status !== 'idle') continue;
      const pending = this.queue.get(id);
      this.queue.delete(id);
      this.hooks.onChange?.(id);
      if (pending) for (const item of pending) this.inject(session, item);
    }
  }

  /** Currently queued items for `targetId`, oldest first — read-only
   *  snapshot for a UI (focus composer's removable chips). */
  peek(targetId: string): T[] {
    return this.queue.get(targetId) ?? [];
  }

  /** Removes one queued item by index (a composer chip's own remove
   *  button) — a no-op if `index` is already stale (flushed/removed since
   *  the caller last read `peek`). */
  remove(targetId: string, index: number): void {
    const q = this.queue.get(targetId);
    if (!q || index < 0 || index >= q.length) return;
    q.splice(index, 1);
    if (q.length === 0) this.queue.delete(targetId);
    this.hooks.onChange?.(targetId);
  }

  /** Drops every queued item for every target — for a caller whose own
   *  upstream source of truth just reset (arceusRelay.ts: a fresh Arceus
   *  process has nothing left to resolve a stale queue against). */
  clear(): void {
    for (const id of [...this.queue.keys()]) {
      this.queue.delete(id);
      this.hooks.onChange?.(id);
    }
  }

  private inject(target: SessionRecord, item: T): void {
    const res = this.writePty(target.id, this.toPayload(item));
    if (res instanceof Promise) {
      void res.then((r) => this.hooks.onDeliver?.(target, item, r));
    } else {
      this.hooks.onDeliver?.(target, item, res);
    }
  }
}
