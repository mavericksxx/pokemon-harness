import { create } from 'zustand';
import type { SessionRecord } from '@shared/types';

/** Field-for-field `SessionRecord` (shared/types.ts) — kept as a local alias
 *  so call sites here read the same as before the crash-recovery work moved
 *  the shape to `shared/` (main needs it too, to mirror sessions for a
 *  post-crash `restoreSessions` — see main/index.ts and
 *  src/renderer/src/sessions.ts's `startRegistrySync`). */
export type Session = SessionRecord;

/** Walker tints, cycled per session. */
const ACCENTS = [0xffd166, 0x8ecae6, 0xff8fa3, 0xb5e48c, 0xc8a2ff, 0xffb27a];

/** Auto-dismiss delay for a toast, ms. */
const TOAST_DURATION_MS = 4500;

export interface Toast {
  id: string;
  text: string;
}

interface HarnessState {
  sessions: Session[];
  selectedId: string | null;
  drawerOpen: boolean;
  toasts: Toast[];

  addSession(
    s: Omit<Session, 'accent' | 'createdAt' | 'status' | 'station' | 'workedMs'>
  ): Session;
  /** Evolution lines already spoken for by a live session — the picker greys
   *  these out and startSession avoids them, so no two walkers are on the same
   *  line at once. */
  takenLines(): string[];
  updateSession(id: string, patch: Partial<Session>): void;
  removeSession(id: string): void;
  /** Boot-time crash recovery (main/index.ts's `sessions:restore`): replaces
   *  the session list outright with already-complete records (no defaults to
   *  fill in, unlike `addSession`), so the drawer and garden pick them
   *  straight back up. `selectedId` is whatever main last saw selected
   *  (null if that session didn't come back, or nothing was selected) —
   *  falls back to the first restored session so a non-empty restore never
   *  leaves the drawer showing nothing. */
  restoreSessions(sessions: Session[], selectedId: string | null): void;
  select(id: string | null): void;
  setDrawerOpen(open: boolean): void;
  /** Non-blocking notification (e.g. a lazy sprite fetch failure). Dismisses
   *  itself after a few seconds. */
  pushToast(text: string): void;
  dismissToast(id: string): void;
}

export const useStore = create<HarnessState>((set, get) => ({
  sessions: [],
  selectedId: null,
  drawerOpen: true,
  toasts: [],

  addSession: (s) => {
    const session: Session = {
      ...s,
      status: 'starting',
      station: 'wander',
      workedMs: 0,
      accent: ACCENTS[get().sessions.length % ACCENTS.length],
      createdAt: Date.now()
    };
    set((st) => ({ sessions: [...st.sessions, session], selectedId: session.id }));
    return session;
  },

  takenLines: () => get().sessions.map((s) => s.line),

  updateSession: (id, patch) =>
    set((st) => {
      const i = st.sessions.findIndex((s) => s.id === id);
      if (i === -1) return st;
      const next = st.sessions.slice();
      next[i] = { ...next[i], ...patch };
      return { sessions: next };
    }),

  removeSession: (id) =>
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      return {
        sessions,
        selectedId: st.selectedId === id ? (sessions[0]?.id ?? null) : st.selectedId
      };
    }),

  restoreSessions: (sessions, selectedId) =>
    set({ sessions, selectedId: selectedId ?? sessions[0]?.id ?? null }),

  select: (id) => set({ selectedId: id }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),

  pushToast: (text) => {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((st) => ({ toasts: [...st.toasts, { id, text }] }));
    window.setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}));
