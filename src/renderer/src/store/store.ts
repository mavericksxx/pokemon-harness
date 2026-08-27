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
  /** Walker tint / UI accent. */
  accent: number;
  exitCode?: number;
  error?: string;
  createdAt: number;
}

/** Walker tints, cycled per session. */
const ACCENTS = [0xffd166, 0x8ecae6, 0xff8fa3, 0xb5e48c, 0xc8a2ff, 0xffb27a];

interface HarnessState {
  sessions: Session[];
  selectedId: string | null;
  drawerOpen: boolean;

  addSession(s: Omit<Session, 'accent' | 'createdAt' | 'status' | 'station'>): Session;
  updateSession(id: string, patch: Partial<Session>): void;
  removeSession(id: string): void;
  select(id: string | null): void;
  setDrawerOpen(open: boolean): void;
}

export const useStore = create<HarnessState>((set, get) => ({
  sessions: [],
  selectedId: null,
  drawerOpen: true,

  addSession: (s) => {
    const session: Session = {
      ...s,
      status: 'starting',
      station: 'wander',
      accent: ACCENTS[get().sessions.length % ACCENTS.length],
      createdAt: Date.now()
    };
    set((st) => ({ sessions: [...st.sessions, session], selectedId: session.id }));
    return session;
  },

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
  setDrawerOpen: (open) => set({ drawerOpen: open })
}));
