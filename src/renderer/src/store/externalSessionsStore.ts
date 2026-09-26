/**
 * External sessions (docs/external-sessions-plan.md §7) — renderer-side
 * store for the "Other sessions" list and the chat preview. Deliberately
 * separate from `@/store/store.ts` (session/garden state) — same reasoning
 * as `usageStore.ts`: this store only ever holds what main's
 * `externalSessions:*` IPC returns/pushes, it never derives session state
 * itself.
 *
 * `previewExternalId` is intentionally NOT part of `store.ts`'s
 * `selectedId` — that field is checkpointed to main on every change and
 * restored on relaunch (see store.ts ~577's own comment), and a preview
 * pane has no business surviving a relaunch or being treated as "the
 * selected session" by anything that reads `selectedId` for that purpose.
 */
import { create } from 'zustand';
import type { ExternalSessionSummary } from '@shared/externalSessions';

/** "Other sessions" section collapse (RosterStrip.tsx) — persisted the same
 *  way store.ts's own `railCollapsed` is, default collapsed (plan §7). */
const COLLAPSED_STORAGE_KEY = 'poke:otherSessionsCollapsed';

function loadCollapsed(): boolean {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw !== null) return raw === '1';
  } catch {
    /* ignore */
  }
  return true; // default collapsed, per plan §7
}

interface ExternalSessionsState {
  sessions: ExternalSessionSummary[];
  loading: boolean;
  collapsed: boolean;
  /** The external session currently shown in the read-only preview, or null
   *  when the preview isn't open. See this file's header for why this is
   *  separate from store.ts's `selectedId`. */
  previewExternalId: string | null;
  setSessions(sessions: ExternalSessionSummary[]): void;
  setLoading(loading: boolean): void;
  setCollapsed(collapsed: boolean): void;
  setPreviewExternalId(id: string | null): void;
  /** Drops one row locally the instant a Continue spawn succeeds, so the
   *  list doesn't have to wait for the next poll to stop showing a session
   *  that's now an ordinary tab. A later poll is still the source of truth
   *  (it also independently excludes the same id) — this is just UI
   *  latency, not a second source of truth. */
  removeSession(id: string): void;
}

export const useExternalSessionsStore = create<ExternalSessionsState>((set) => ({
  sessions: [],
  loading: false,
  collapsed: loadCollapsed(),
  previewExternalId: null,
  setSessions: (sessions) => set({ sessions }),
  setLoading: (loading) => set({ loading }),
  setCollapsed: (collapsed) => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ collapsed });
  },
  setPreviewExternalId: (id) => set({ previewExternalId: id }),
  removeSession: (id) => set((st) => ({ sessions: st.sessions.filter((s) => s.id !== id) }))
}));
