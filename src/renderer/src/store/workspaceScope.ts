/** Sessions belonging to the currently active workspace (Phase 8.7) — the
 *  scoping the roster strip, sessions overview, terminal drawer tab strip,
 *  and the topbar's legacy session-chips fallback all use, so the garden
 *  (GardenScene, which reads the stores imperatively rather than through a
 *  hook) is the only place this filter is duplicated instead of shared. */
import { useMemo } from 'react';
import { useStore, type Session } from '@/store/store';
import { sessionWorkspaceId, useWorkspaceStore } from '@/store/workspaceStore';
import { isGlobalSession } from '@shared/arceus';

export function useActiveWorkspaceSessions(): Session[] {
  const sessions = useStore((s) => s.sessions);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return useMemo(
    // Arceus (Phase 8.8) is global — every workspace's scoped list includes
    // him regardless of `activeWorkspaceId`.
    () => sessions.filter((s) => isGlobalSession(s) || sessionWorkspaceId(s) === activeWorkspaceId),
    [sessions, activeWorkspaceId]
  );
}
