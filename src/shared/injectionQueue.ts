/**
 * Shared idle-queue + pty-injection helper (BACKLOG phase E) — originally
 * extracted from the deleted main/arceusRelay.ts's hand-rolled per-target
 * `Map` so its safety rail is isolated from the relay logic around it:
 * never write into a session's pty unless it's genuinely idle (a permission
 * prompt must never get auto-answered), queue the payload otherwise, and
 * deliver it (FIFO) the moment that session next goes idle — dropping the
 * queue outright once the session closes or finishes. Now used by
 * main/pokeTools.ts's `PokeRelay` (Arceus v2's `poke-relay`, replacing
 * arceusRelay.ts's own use of this class one-for-one).
 *
 * Dependency-free (no node/electron imports — same "shared wire shape"
 * convention as costTypes.ts/audioTypes.ts) so an instance can live main-side
 * (PokeRelay, writing synchronously via ptyManager.write) without pulling in
 * electron itself; a renderer-side instance, writing over the async
 * `window.api.writePty` IPC bridge, would only need to supply its own
 * `writePty` callback, `toPayload`, and logging/UI hooks.
 *
 * Generic over the queued item type `T` (plain `string` for `PokeRelay`) —
 * `toPayload` is how the queue turns one `T` into the exact string written
 * to the pty.
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
   *  or removed. Not needed by `PokeRelay` (nothing renders its queue); a UI
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
   *  (e.g. a `poke-relay` request's own `agent` field) can do so at the call
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

  /** True when nothing is queued for any target. */
  isEmpty(): boolean {
    return this.queue.size === 0;
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
   *  upstream source of truth just reset (e.g. nothing left to resolve a
   *  stale queue against). Not currently called by `PokeRelay` (it has no
   *  such reset event — a real tool call, not a tailed transcript, discovers
   *  each relay), kept as part of this class's general-purpose API. */
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
