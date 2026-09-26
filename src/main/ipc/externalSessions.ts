/** IPC for the "Other sessions" list, chat preview and continue flow
 *  (docs/external-sessions-plan.md §7 steps 1–3). */
import type { WebContents } from 'electron';
import { handle } from './handle';
import { checkContinueTarget, ExternalSessionsService } from '../externalSessions';
import { ExternalTranscriptService } from '../externalTranscript';
import type { ExternalSessionsListResult, ExternalTranscriptPage } from '../../shared/externalSessions';
import type { SessionRecord } from '../../shared/types';

export interface ExternalSessionsIpcDeps {
  getSessionRegistry: () => SessionRecord[];
  getWebContents: () => WebContents | null;
}

export function registerExternalSessionsIpc(deps: ExternalSessionsIpcDeps): void {
  const service = new ExternalSessionsService(deps.getSessionRegistry);
  const transcripts = new ExternalTranscriptService();
  // One live tail subscription at a time per conversation id — the preview
  // only ever has one open row (§2), and a fresh `subscribe` for the same id
  // replaces any prior one rather than leaking a second watcher.
  const subscriptions = new Map<string, () => void>();

  handle('externalSessions:list', async (): Promise<ExternalSessionsListResult> => {
    const sessions = await service.list();
    return { sessions };
  });

  handle(
    'externalSessions:readTranscript',
    async (_e, path: string, cursor: number | null): Promise<ExternalTranscriptPage> => {
      return transcripts.readPage(path, cursor);
    }
  );

  // The renderer already has title/model/permissionMode/source for this row
  // from its last `list()` call — this handler only adds the two disk-
  // existence checks that can go stale between listing and clicking
  // Continue (plan §7: "verify the transcript exists before spawning").
  handle(
    'externalSessions:checkContinueTarget',
    async (_e, transcriptPath: string, cwd: string): Promise<{ cwdExists: boolean; transcriptExists: boolean }> => {
      return checkContinueTarget(transcriptPath, cwd);
    }
  );

  handle(
    'externalSessions:subscribe',
    async (_e, id: string, path: string, fromOffset: number): Promise<void> => {
      subscriptions.get(id)?.();
      const unsubscribe = transcripts.subscribe(path, fromOffset, (turns) => {
        const wc = deps.getWebContents();
        if (!wc || wc.isDestroyed()) return;
        try {
          wc.send(`externalSessions:turns:${id}`, turns);
        } catch {
          /* window tore down mid-send */
        }
      });
      subscriptions.set(id, unsubscribe);
    }
  );

  handle('externalSessions:unsubscribe', async (_e, id: string): Promise<void> => {
    subscriptions.get(id)?.();
    subscriptions.delete(id);
  });
}
