/**
 * Focus mode's queue composer (BACKLOG phase E) — per-session idle-queue +
 * injection, built on the SAME shared helper main/arceusRelay.ts uses
 * (shared/injectionQueue.ts) rather than a second hand-rolled queue, so the
 * safety rail is identical: never write into a session's pty unless it's
 * genuinely idle (a permission prompt must never get auto-answered), queue
 * the message otherwise, and deliver it the moment that session next goes
 * idle — dropping the queue outright once the session closes.
 *
 * Lives renderer-side, unlike arceusRelay's instance: the renderer already
 * holds the live, reactive session list (`useStore`) that both `submit` (an
 * idle check) and `flush` (the queue-drain trigger) need, so routing this
 * through main over new IPC would just re-derive status main already learns
 * FROM the renderer (`sessions:checkpoint`) — see this file's own
 * `startFocusQueueFlush`. One consequence, and a deliberate one: this queue
 * does NOT survive a renderer crash/reload (module state, not persisted) —
 * correct here, since a queued composer message is unsent user input for a
 * session that's still live and the spec already says to drop queued items
 * once a session closes.
 *
 * `FocusQueueItem.text` is what a chip displays; `.payload` is the exact
 * bytes written to the pty — bracketed-paste-wrapped (see arceus.ts's
 * `wrapBracketedPaste`, reused here) plus a trailing `\r` for a multiline
 * message, or just `text + '\r'` for a single line, matching
 * ArceusDispatchBox.tsx's own plain `${trimmed}\r`.
 */
import { create } from 'zustand';
import type { SessionRecord } from '@shared/types';
import { InjectionQueue } from '@shared/injectionQueue';
import { useStore } from '@/store/store';
import { wrapBracketedPaste } from '@/arceus';

/** Same per-target cap as arceusRelay.ts's MAX_QUEUE_PER_TARGET — a chatty
 *  user queuing repeatedly into one stuck session can't grow this without
 *  bound either. Oldest drops first (InjectionQueue's own rule). */
const MAX_QUEUE_PER_TARGET = 20;

export interface FocusQueueItem {
  /** Human-readable text for the composer's removable chip. */
  text: string;
  /** Exact bytes written to the pty on delivery. */
  payload: string;
}

interface FocusQueueState {
  bySession: Record<string, FocusQueueItem[]>;
}

/** Mirrors `queue`'s per-session contents so a React component can
 *  subscribe and re-render — the `InjectionQueue` instance itself is plain
 *  module state, not something React can watch directly. Kept in sync from
 *  `queue`'s own `onChange` hook (`syncSession`, below), not written to any
 *  other way. */
const useFocusQueueStore = create<FocusQueueState>(() => ({ bySession: {} }));

function syncSession(sessionId: string): void {
  const items = queue.peek(sessionId);
  useFocusQueueStore.setState((s) => {
    if (items.length === 0) {
      if (!(sessionId in s.bySession)) return s;
      const rest = { ...s.bySession };
      delete rest[sessionId];
      return { bySession: rest };
    }
    return { bySession: { ...s.bySession, [sessionId]: items } };
  });
}

const queue = new InjectionQueue<FocusQueueItem>(
  (id, data) => window.api.writePty(id, data),
  MAX_QUEUE_PER_TARGET,
  (item) => item.payload,
  { onChange: syncSession }
);

/** A session's queued items, oldest first — FocusComposer.tsx reads this to
 *  render its removable "queued · sends when idle" chips. Reactive: updates
 *  whenever this session's queue changes, including from another session
 *  being selected in between (the queue itself is keyed per-session and
 *  outlives the composer component switching agents). */
export function useFocusQueue(sessionId: string): FocusQueueItem[] {
  return useFocusQueueStore((s) => s.bySession[sessionId] ?? []);
}

/** Submits one composer message for the session `sessionId` — injects
 *  immediately if it's idle, otherwise queues it. Multiline text (an actual
 *  paste, or a manually-typed shift+enter line break) goes through the same
 *  bracketed-paste wrap Arceus's first-prompt delivery uses, so embedded
 *  newlines land as literal content instead of each submitting early.
 *
 *  Takes an id, not a `Session` record, and re-reads the CURRENT record from
 *  the store here rather than trusting whatever `FocusComposer` had in
 *  props: that prop can be one render stale (e.g. a keystroke handler
 *  closing over a `Session` captured before a status flip). The safety rail
 *  this queue exists for is "never inject into a non-idle session" — a
 *  stale `status: 'idle'` prop for a session that has since gone 'blocked'
 *  on a real permission prompt would defeat that rail exactly when it
 *  matters most, so `submit` must see the freshest status available. */
export function submitFocusMessage(sessionId: string, text: string): 'sent' | 'queued' | 'gone' {
  const session = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return 'gone';
  const payload = text.includes('\n') ? `${wrapBracketedPaste(text)}\r` : `${text}\r`;
  return queue.submit(session, { text, payload });
}

/** A composer chip's own remove button — a no-op if the item already got
 *  delivered/dropped since the chip was rendered. */
export function removeFocusQueueItem(sessionId: string, index: number): void {
  queue.remove(sessionId, index);
}

/** Subscribes once to the session store and flushes the queue on every
 *  change — same "subscribe once at boot" shape as sessions.ts's
 *  `startRegistrySync`/`startCompletionToasts`. Call once, from main.tsx's
 *  boot(). */
export function startFocusQueueFlush(): void {
  let lastSessions: SessionRecord[] | null = null;
  useStore.subscribe((state) => {
    if (state.sessions === lastSessions) return;
    lastSessions = state.sessions;
    queue.flush(state.sessions);
  });
}
