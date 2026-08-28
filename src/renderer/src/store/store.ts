import { create } from 'zustand';
import type { AgentProviderId } from '@shared/agentProvider';
import type { SessionStatus, StationKind } from '@shared/types';

export interface Session {
  id: string;
  title: string;
  cwd: string;
  command: string;
  provider: AgentProviderId;
  model?: string;
  status: SessionStatus;
  /** Last tool the parser saw, e.g. 'Read'. */
  tool?: string;
  /** That tool's argument, e.g. a file path. */
  toolTarget?: string;
  /** Where the walker should be, derived from `tool`. */
  station: StationKind;
  /** Which Pokemon walks for this session right now — its current evolution
   *  stage. Sessions always hatch at their line's stage 1 and this is mutated
   *  in place as thresholds are crossed. */
  pokemon: string;
  /** Evolution line id (shared by every stage) — uniqueness is per line, not
   *  per exact species, so a session can't claim a stage of a line another
   *  session is already walking. */
  line: string;
  /** Rolled once at session creation (Phase 5 §1) and kept for the session's
   *  whole lifetime, through every evolution stage. Not a property of the
   *  species — of this particular session's Pokemon. */
  shiny: boolean;
  /** Accumulated milliseconds spent in `working` status. Idle/blocked/wall-clock
   *  time does not count. Drives the evolution thresholds in `evolution.ts`. */
  workedMs: number;
  /** Selection-ring / UI accent. */
  accent: number;
  exitCode?: number;
  error?: string;
  createdAt: number;
}

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

  select: (id) => set({ selectedId: id }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),

  pushToast: (text) => {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((st) => ({ toasts: [...st.toasts, { id, text }] }));
    window.setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}));
