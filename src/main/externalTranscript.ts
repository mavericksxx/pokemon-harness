/**
 * ExternalTranscriptService — the read-only chat preview's transcript reader
 * (docs/external-sessions-plan.md §7 step 3). Parses a Claude Code JSONL
 * transcript into normalized turns without ever calling into the CLI itself
 * (§3: no side-effect-free viewer exists — `--resume`/`--fork-session` both
 * write and fire hooks).
 *
 * Pagination reads BACKWARD from the end (or from a previous page's cursor)
 * in ~1 MB chunks, so opening a 195 MB transcript only reads its tail, not
 * the whole file — see `readPage`. Every open re-reads the file fresh (§2:
 * "the preview is always live") — there is no cross-open cache here, unlike
 * externalSessions.ts's list cache.
 *
 * Live tail reuses costWatcher.ts's own offset+partial-line-carry approach:
 * read forward from a saved byte offset, split on '\n', carry any trailing
 * incomplete line to the next read. `fs.watch` is the primary trigger, with
 * no fallback poll here (the preview is only ever open in the foreground;
 * unlike costWatcher there's no "must still update while backgrounded"
 * requirement, and the caller closes the subscription on unmount).
 */
import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { ExternalTranscriptPage, ExternalTranscriptTurn } from '../shared/externalSessions';

/** Backward-page target size — grown in these increments until either this
 *  many raw lines have been collected or the start of the file is reached. */
const CHUNK_BYTES = 1024 * 1024;
/** Stop growing a backward page once at least this many TURNS (post-filter)
 *  have been collected, or after MAX_CHUNKS chunks, whichever comes first —
 *  a long run of skipped meta records must not force reading the whole file
 *  in one page. */
const TARGET_TURNS_PER_PAGE = 60;
const MAX_CHUNKS_PER_PAGE = 24; // hard cap: 24MB per page read, worst case

interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function safeParse(line: string): RawRecord | null {
  if (!line || line.length > 500_000) return null;
  try {
    return JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
}

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const file = typeof input?.file_path === 'string' ? (input.file_path as string) : undefined;
  switch (name) {
    case 'Edit':
    case 'NotebookEdit':
      return file ? `Edited ${file}` : 'Edited a file';
    case 'Write':
      return file ? `Wrote ${file}` : 'Wrote a file';
    case 'Read':
      return file ? `Read ${file}` : 'Read a file';
    case 'Bash': {
      const cmd = typeof input?.command === 'string' ? (input.command as string) : '';
      return `Ran: ${cmd.slice(0, 200)}`;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = typeof input?.pattern === 'string' ? (input.pattern as string) : '';
      return `Searched: ${pattern}`;
    }
    default:
      return `Called ${name}`;
  }
}

/** Turns a single JSONL line's parsed record into 0 or more normalized turns
 *  (an assistant record with several content blocks can yield several). Skips
 *  every meta/queue-operation/tool_result/attachment/sidechain record — see
 *  this file's header. */
function recordToTurns(rec: RawRecord): ExternalTranscriptTurn[] {
  if (rec.isSidechain) return [];
  const at = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  const atMs = Number.isNaN(at) ? 0 : at;
  const id = rec.uuid ?? `${rec.type}-${atMs}-${Math.random().toString(36).slice(2, 8)}`;

  if (rec.type === 'user' && rec.message?.role === 'user') {
    const content = rec.message.content;
    if (typeof content === 'string' && content.trim()) {
      return [{ kind: 'user', id, at: atMs, text: content.trim() }];
    }
    return []; // array content on a user record is a tool_result/attachment echo — skip
  }

  if (rec.type === 'assistant' && rec.message?.role === 'assistant') {
    const content = rec.message.content;
    if (!Array.isArray(content)) return [];
    const turns: ExternalTranscriptTurn[] = [];
    let textAccum = '';
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        textAccum += (textAccum ? '\n' : '') + b.text;
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        if (textAccum.trim()) {
          turns.push({ kind: 'assistant', id: `${id}-text`, at: atMs, text: textAccum.trim() });
          textAccum = '';
        }
        turns.push({
          kind: 'tool',
          id: `${id}-${String(b.id ?? b.name)}`,
          at: atMs,
          summary: toolSummary(b.name, b.input as Record<string, unknown> | undefined)
        });
      }
      // 'thinking' blocks and anything else are intentionally dropped.
    }
    if (textAccum.trim()) turns.push({ kind: 'assistant', id: `${id}-text`, at: atMs, text: textAccum.trim() });
    return turns;
  }

  return []; // every other record type (meta/system/custom-title/cost-state/...) is skipped
}

export class ExternalTranscriptService {
  /** Backward pagination — see this file's header. `cursor` is the byte
   *  offset returned by a previous call (or null to start at EOF). Never
   *  caches across calls: every open re-reads fresh (§2). */
  async readPage(path: string, cursor: number | null): Promise<ExternalTranscriptPage> {
    let fd: number;
    let size: number;
    try {
      size = statSync(path).size;
      fd = openSync(path, 'r');
    } catch {
      return { turns: [], cursor: null, tailOffset: cursor ?? 0 };
    }
    try {
      const end = cursor ?? size;
      if (end <= 0) return { turns: [], cursor: null, tailOffset: size };

      let readStart = end;
      let text = '';
      let chunks = 0;
      let turns: ExternalTranscriptTurn[] = [];

      while (readStart > 0 && chunks < MAX_CHUNKS_PER_PAGE) {
        const wantLen = Math.min(CHUNK_BYTES, readStart);
        const nextStart = readStart - wantLen;
        const buf = Buffer.alloc(wantLen);
        readSync(fd, buf, 0, wantLen, nextStart);
        text = buf.toString('utf8') + text;
        readStart = nextStart;
        chunks++;

        // Drop a partial leading line UNLESS we've reached the start of the
        // file — a chunk boundary can land mid-line.
        let usable = text;
        if (readStart > 0) {
          const firstNl = usable.indexOf('\n');
          if (firstNl === -1) continue; // no complete line yet — grow the window
          usable = usable.slice(firstNl + 1);
        }

        const lines = usable.split('\n').filter((l) => l.trim().length > 0);
        turns = [];
        for (const line of lines) {
          const rec = safeParse(line);
          if (!rec) continue;
          turns.push(...recordToTurns(rec));
        }
        if (turns.length >= TARGET_TURNS_PER_PAGE || readStart === 0) break;
      }

      const newCursor = readStart > 0 ? readStart : null;
      return { turns, cursor: newCursor, tailOffset: size };
    } catch {
      return { turns: [], cursor: null, tailOffset: size };
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  /** Live tail: watches `path` for growth past `fromOffset` and invokes
   *  `onTurns` with each newly-appended batch, oldest-first. Returns an
   *  unsubscribe function. Best-effort — a missing/removed file is simply
   *  never tailed (no error surfaced; the preview just stops updating,
   *  matching a closed/rotated transcript). */
  subscribe(path: string, fromOffset: number, onTurns: (turns: ExternalTranscriptTurn[]) => void): () => void {
    let offset = fromOffset;
    let carry = '';
    let watcher: FSWatcher | null = null;
    let closed = false;

    const tail = (): void => {
      if (closed) return;
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return;
      }
      if (size <= offset) return;
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch {
        return;
      }
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        offset = size;
        const chunk = carry + buf.toString('utf8');
        const lines = chunk.split('\n');
        carry = lines.pop() ?? '';
        const turns: ExternalTranscriptTurn[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const rec = safeParse(trimmed);
          if (!rec) continue;
          turns.push(...recordToTurns(rec));
        }
        if (turns.length) onTurns(turns);
      } catch {
        /* best-effort — retried on the next watch event */
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };

    try {
      watcher = watch(path, () => tail());
      watcher.on('error', () => {
        /* stop tailing silently — see this method's own comment */
      });
    } catch {
      watcher = null;
    }

    return () => {
      closed = true;
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    };
  }
}
