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
  /** Optional single action button (Phase 8.5 #3's "steer" offer on a
   *  looping session) — dismisses the toast when clicked, same as clicking
   *  the toast body itself does. */
  action?: { label: string; onClick: () => void };
}

/** One of three layouts (was four — 'terminalFull' was dropped: it and
 *  'terminal' both hid the garden and gave the terminal the whole body, and
 *  users reported the two view-switcher buttons as duplicates. 'terminal'
 *  is the one that survived — its bottom roster strip is the same
 *  session-switching UI 'garden' mode already uses, instead of
 *  'terminalFull''s topbar chips + drawer tab strip):
 *   'garden'     — garden fills the body, terminal drawer toggles as a side
 *                  panel (`drawerOpen`).
 *   'terminal'   — munder-difflin's layout: a bottom roster strip of agent
 *                  cards, terminal owning the rest. Garden stays mounted
 *                  (simulation keeps running) but hidden.
 *   'gardenFull' — garden fills the whole body, no terminal. */
export type ViewMode = 'garden' | 'terminal' | 'gardenFull';

const VIEW_MODE_STORAGE_KEY = 'poke:viewMode';
const VALID_VIEW_MODES: readonly ViewMode[] = ['garden', 'terminal', 'gardenFull'];

/** Best-effort read of the last view mode — localStorage can throw (private
 *  browsing/disabled storage); default to the pre-Phase-8 layout on failure. */
function loadViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (v && (VALID_VIEW_MODES as string[]).includes(v)) return v as ViewMode;
  } catch {
    /* ignore */
  }
  return 'garden';
}

interface HarnessState {
  sessions: Session[];
  selectedId: string | null;
  drawerOpen: boolean;
  toasts: Toast[];
  viewMode: ViewMode;
  /** Sessions-overview grid (Phase 8 §3) — a topbar button and (Phase 8 §7)
   *  the garden's signpost prop both open it. */
  sessionsOverviewOpen: boolean;
  /** Settings panel (Phase 8 §5) — a topbar gear button and (Phase 8 §7)
   *  the garden's well prop both open it. */
  settingsOpen: boolean;
  /** Quit-intercept dialog (parity sweep item 2) — opened when main prevents
   *  a close/quit because sessions are still live; `quitDialogCount` is
   *  main's own authoritative live-session count (see closingTime.ts's
   *  `startQuitInterceptListener`). */
  quitDialogOpen: boolean;
  quitDialogCount: number;

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
  /** Switches the Phase 8 §1 layout and persists it (survives relaunch and
   *  the crash-recovery reload). */
  setViewMode(mode: ViewMode): void;
  setSessionsOverviewOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setQuitDialogOpen(open: boolean, count?: number): void;
  /** Non-blocking notification (e.g. a lazy sprite fetch failure). Dismisses
   *  itself after a few seconds. `action` adds a single button (Phase 8.5 #3). */
  pushToast(text: string, action?: Toast['action']): void;
  dismissToast(id: string): void;
}

export const useStore = create<HarnessState>((set, get) => ({
  sessions: [],
  selectedId: null,
  drawerOpen: true,
  toasts: [],
  viewMode: loadViewMode(),
  sessionsOverviewOpen: false,
  settingsOpen: false,
  quitDialogOpen: false,
  quitDialogCount: 0,

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
  setViewMode: (mode) => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      /* ignore — mode still applies for this session */
    }
    set({ viewMode: mode });
  },
  setSessionsOverviewOpen: (open) => set({ sessionsOverviewOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setQuitDialogOpen: (open, count) => set((st) => ({ quitDialogOpen: open, quitDialogCount: count ?? st.quitDialogCount })),

  pushToast: (text, action) => {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((st) => ({ toasts: [...st.toasts, { id, text, action }] }));
    window.setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}));
