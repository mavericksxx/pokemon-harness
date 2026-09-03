/**
 * Workspace registry disk persistence (Phase 8.7) — `workspaces.json` in the
 * harness home directory (see harnessHome.ts), NOT Electron's userData.
 * Same atomic tmp+rename write as sessionPersistence.ts (a crash mid-write
 * must never leave a corrupt registry for the next launch to choke on), but
 * written synchronously and immediately on every mutation rather than
 * debounced: workspace create/rename/delete/switch are rare, user-driven
 * actions, not a 60Hz stream of checkpoints.
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_WORKSPACE_ID, type WorkspaceRecord, type WorkspaceSnapshot } from '../shared/workspaceTypes';
import type { SessionRecord } from '../shared/types';

function workspacesFilePath(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'workspaces.json');
}

async function loadWorkspaceRegistry(harnessHomeDir: string): Promise<WorkspaceSnapshot | null> {
  const p = workspacesFilePath(harnessHomeDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<WorkspaceSnapshot>;
    if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) return null;
    const activeWorkspaceId =
      raw.activeWorkspaceId && raw.workspaces.some((w) => w.id === raw.activeWorkspaceId)
        ? raw.activeWorkspaceId
        : raw.workspaces[0].id;
    return { workspaces: raw.workspaces, activeWorkspaceId };
  } catch {
    // Corrupt/truncated file — never let a bad registry block boot; treat
    // it the same as "doesn't exist yet" and let the caller re-init.
    return null;
  }
}

/** Atomic (tmp+rename) synchronous write — same shape as
 *  SessionPersistence.flush() in sessionPersistence.ts. */
export function saveWorkspaceRegistry(harnessHomeDir: string, snapshot: WorkspaceSnapshot): void {
  try {
    mkdirSync(harnessHomeDir, { recursive: true });
    const p = workspacesFilePath(harnessHomeDir);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    console.error('[workspaces] persisting registry failed:', e);
  }
}

/** Load the registry from `harnessHomeDir`, or create+persist a fresh
 *  one-workspace default if none exists there yet (first launch ever, OR a
 *  harness-home folder the user just pointed at that has no registry of its
 *  own). Named after the first pre-existing persisted session's repo folder
 *  when this is an upgrade from before workspaces existed (so the migration
 *  reads as "your existing work became workspace 1", not a mystery default);
 *  otherwise the warm placeholder "garden 1" for a genuinely fresh install. */
export async function initWorkspaceRegistry(
  harnessHomeDir: string,
  firstSessionCwd?: string
): Promise<WorkspaceSnapshot> {
  const existing = await loadWorkspaceRegistry(harnessHomeDir);
  if (existing) return existing;

  const workspace: WorkspaceRecord = {
    id: DEFAULT_WORKSPACE_ID,
    name: firstSessionCwd ? basename(firstSessionCwd.replace(/\/+$/, '')) || 'garden 1' : 'garden 1',
    primaryFolder: firstSessionCwd || homedir(),
    createdAt: Date.now()
  };
  const snapshot: WorkspaceSnapshot = { workspaces: [workspace], activeWorkspaceId: workspace.id };
  saveWorkspaceRegistry(harnessHomeDir, snapshot);
  return snapshot;
}

export interface WorkspaceRepair {
  workspaceId: string;
  oldPath: string;
  newPath: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Repair paths and quick-picks before the renderer sees them at boot. */
export function repairWorkspaceFolders(
  snapshot: WorkspaceSnapshot,
  sessions: SessionRecord[],
  recentFolders: string[]
): { snapshot: WorkspaceSnapshot; recentFolders: string[]; repairs: WorkspaceRepair[] } {
  const repairs: WorkspaceRepair[] = [];
  const workspaces = snapshot.workspaces.map((workspace) => {
    if (isDirectory(workspace.primaryFolder)) return workspace;
    const workspaceSessions = sessions.filter(
      (session) => (session.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspace.id
    );
    const replacement = [...workspaceSessions].reverse().find((session) => isDirectory(session.cwd))?.cwd ?? homedir();
    repairs.push({ workspaceId: workspace.id, oldPath: workspace.primaryFolder, newPath: replacement });
    return { ...workspace, primaryFolder: replacement };
  });
  return {
    snapshot: { ...snapshot, workspaces },
    recentFolders: recentFolders.filter(isDirectory),
    repairs
  };
}
