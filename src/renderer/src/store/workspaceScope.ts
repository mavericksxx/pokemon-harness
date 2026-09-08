/** Sessions belonging to the currently active workspace (Phase 8.7) — the
 *  scoping the roster strip, sessions overview, terminal drawer tab strip,
 *  and the topbar's legacy session-chips fallback all use, so the garden
 *  (GardenScene, which reads the stores imperatively rather than through a
 *  hook) is the only place this filter is duplicated instead of shared. */
import { useShallow } from 'zustand/react/shallow';
import { useStore, type Session } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { isGlobalSession } from '@shared/arceus';

export function useActiveWorkspaceSessions(): Session[] {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // `useShallow` (not a `useMemo` off `s.sessions`) — `s.sessions` is a new
  // array reference on every store update (even a no-op-guarded one still
  // replaces unrelated fields elsewhere), so a plain `useMemo` keyed on it
  // recomputed the filter every time regardless of whether THIS workspace's
  // membership actually changed. Shallow-comparing the filtered result means
  // consumers of this hook only re-render when a session enters/leaves the
  // active workspace, or when one of its own session objects gets a new
  // identity (a real patch — see store.ts's `updateSession` no-op guard) —
  // not on every unrelated session's tick.
  return useStore(
    useShallow((s) =>
      // Arceus (Phase 8.8) is global — every workspace's scoped list includes
      // him regardless of `activeWorkspaceId`.
      s.sessions.filter((x) => isGlobalSession(x) || sessionWorkspaceId(x) === activeWorkspaceId)
    )
  );
}
