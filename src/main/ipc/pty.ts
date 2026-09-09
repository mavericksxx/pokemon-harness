import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { handle } from './handle';
import type { PtyManager } from '../pty';
import type { CostWatcher } from '../costWatcher';
import type { TaskNotificationWatcher } from '../taskNotificationWatcher';
import type { SessionTitleWatcher } from '../sessionTitleWatcher';
import type { SpawnPtyOptions } from '../../shared/types';

export interface PtyIpcDeps {
  ptyManager: PtyManager;
  costWatcher: CostWatcher;
  taskNotificationWatcher: TaskNotificationWatcher;
  sessionTitleWatcher: SessionTitleWatcher;
}

export function registerPtyIpc(deps: PtyIpcDeps): void {
  const { ptyManager, costWatcher, taskNotificationWatcher, sessionTitleWatcher } = deps;

  // ─── PTY IPC ────────────────────────────────────────────────────────────────
  handle('pty:spawn', (_e, opts: SpawnPtyOptions) => ptyManager.spawn(opts, true));
  handle('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data));
  handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  );
  handle('pty:kill', (_e, id: string) => {
    costWatcher.unregisterSession(id);
    taskNotificationWatcher.unregisterSession(id);
    sessionTitleWatcher.unregisterSession(id);
    return ptyManager.kill(id);
  });
  handle('pty:list', () => ptyManager.list());
  handle('pty:available', (_e, command: string) => ptyManager.isCommandAvailable(command));
  handle('paths:resolveTerminalCwd', (_e, candidates: string[]) => {
    const expand = (candidate: string): string => {
      const trimmed = candidate.trim();
      if (trimmed === '~') return homedir();
      if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
      return resolve(trimmed);
    };
    const isDirectory = (candidate: string): boolean => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    };
    return [...candidates, homedir()].map(expand).find(isDirectory) ?? homedir();
  });
  // First-class delegate sessions (shared/delegateSpawn.ts) — the renderer's
  // `delegate:sessionSpawned` listener (sessions.ts's `startDelegateSpawnListener`)
  // subscribes its terminal to `pty:data:<id>` FIRST, then pulls this to backfill
  // whatever the pty already emitted before that subscription existed: unlike
  // `sessions:restore`'s replay (captured main-side before any renderer round
  // trip even starts), a delegate's pty is already running by the time the
  // renderer hears about it at all, so capturing replay before the subscription
  // risks a real gap — pulling after risks a few duplicated bytes instead, which
  // a live terminal tolerates far better than missing output does.
  handle('pty:replay', (_e, id: string) => ptyManager.getReplay(id));
  // A first-class delegate can finish before the renderer receives its spawned
  // event and installs the terminal listener. Keep that adoption race from
  // losing the done transition (see sessions.ts's adoptDelegateSession).
  handle('pty:exit-info', (_e, id: string) => ptyManager.getDelegateExit(id));
}
