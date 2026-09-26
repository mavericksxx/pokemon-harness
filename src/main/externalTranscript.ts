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

/** Backward-page read increment — grown (by re-reading further back) until
 *  either this many raw lines have been collected or the start of the file
 *  is reached. */
const CHUNK_BYTES = 1024 * 1024;
/** Stop growing a backward page once at least this many TURNS (post-filter)
 *  have been collected, or once MAX_PAGE_BYTES have been read, whichever
 *  comes first — a long run of skipped meta records must not force reading
 *  the whole file in one page (2026-09-26 review, D12: a tail heavy with
 *  tool results could otherwise JSON.parse hundreds of MB synchronously on
 *  main and freeze the app). */
const TARGET_TURNS_PER_PAGE = 60;
const MAX_PAGE_BYTES = 8 * 1024 * 1024; // hard cap: 8MB read per page, worst case
/** A single JSONL line longer than this is skipped WITHOUT being handed to
 *  `JSON.parse` at all (D12) — a pathological single line must not be the
 *  thing that trips MAX_PAGE_BYTES on its own before ever finishing a parse. */
const MAX_LINE_LENGTH = 1_000_000;

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
  if (!line || line.length > MAX_LINE_LENGTH) return null;
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

function truncateForSummary(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n)}…` : trimmed;
}

/** Extracts `<tag>...</tag>`'s inner text (non-greedy, dotall via `[\s\S]`),
 *  or null if `tag` isn't present. */
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

/** Classifies a user record's raw text against the CLI's own bracketed
 *  markup (2026-09-26 review, item 1) — real transcripts interleave genuine
 *  typed prompts with `<local-command-caveat>`, `<command-name>`,
 *  `<local-command-stdout>`, `<bash-input>`/`<bash-stdout>`/`<bash-stderr>`,
 *  `<system-reminder>` and `<task-notification>` records, all inside plain
 *  `type: 'user'` entries indistinguishable by type alone. Verified against
 *  every tag prefix actually observed in ~/.claude/projects (see this
 *  round's report for the scan output) — checked via `startsWith` on the
 *  TRIMMED text, not a bare substring search, since a `/compact` summary's
 *  own prose can legitimately mention "bash-input"/"bash-stdout" without
 *  being one. */
function classifyUserText(
  text: string
): { kind: 'hidden' } | { kind: 'system'; summary: string } | { kind: 'user'; text: string } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'hidden' };
  const startsWithTag = (tag: string): boolean => trimmed.startsWith(`<${tag}>`);

  if (startsWithTag('local-command-caveat')) return { kind: 'hidden' };

  if (startsWithTag('command-name') || startsWithTag('command-message')) {
    const name = extractTag(trimmed, 'command-name');
    if (name) {
      const args = extractTag(trimmed, 'command-args')?.trim();
      return { kind: 'system', summary: args ? `${name} ${args}` : name };
    }
  }

  if (startsWithTag('local-command-stdout')) {
    const inner = extractTag(trimmed, 'local-command-stdout')?.trim();
    return inner ? { kind: 'system', summary: truncateForSummary(inner, 200) } : { kind: 'hidden' };
  }

  if (startsWithTag('bash-input')) {
    const inner = extractTag(trimmed, 'bash-input')?.trim() ?? '';
    return { kind: 'system', summary: `! ${truncateForSummary(inner, 200)}` };
  }

  if (startsWithTag('bash-stdout') || startsWithTag('bash-stderr')) {
    return { kind: 'hidden' };
  }

  if (startsWithTag('task-notification')) {
    const summary = extractTag(trimmed, 'summary')?.trim();
    return { kind: 'system', summary: summary ? `Background task: ${summary}` : 'Background task finished' };
  }

  // Not a whole-message tag — but real prompt text can still have a
  // `<system-reminder>` block embedded in the middle (e.g. a session-name
  // hint appended after the user's own typed text). Strip it out rather
  // than hiding the whole record, and hide the record only if nothing real
  // is left once it's gone.
  const stripped = trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return stripped ? { kind: 'user', text: stripped } : { kind: 'hidden' };
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
      const classified = classifyUserText(content);
      if (classified.kind === 'hidden') return [];
      if (classified.kind === 'system') return [{ kind: 'system', id, at: atMs, summary: classified.summary }];
      return [{ kind: 'user', id, at: atMs, text: classified.text }];
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

/** Splits a block of complete JSONL lines and parses each into turns —
 *  shared by `readPage`'s per-chunk parse and `subscribe`'s per-tail parse,
 *  so a chunk's bytes are only ever handed to `JSON.parse` once (D12). */
function parseLines(block: string): ExternalTranscriptTurn[] {
  const turns: ExternalTranscriptTurn[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rec = safeParse(trimmed);
    if (!rec) continue;
    turns.push(...recordToTurns(rec));
  }
  return turns;
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

      // `pos` is the read pointer: bytes in [0, pos) remain unread for this
      // page. `carry` holds bytes for which no newline has been found YET —
      // either the whole file's tail landed mid-line at `end`, or a chunk
      // boundary did — kept as a raw Buffer (not a string) and PREPENDED
      // with each further-back read rather than discarded, so a record
      // split across a chunk boundary is never lost (2026-09-26 re-review,
      // D12 remaining bug #1: the previous version set `carry = ''` right
      // after finding a boundary, so continuing the loop silently dropped
      // that fragment at every INTERNAL chunk boundary, not just at true
      // page-to-page boundaries). Working in bytes throughout (Buffer.
      // indexOf(0x0a), not string.indexOf('\n')) also fixes bug #3: a
      // string index is a UTF-16 code-unit count, which undercounts for any
      // non-ASCII byte sequence in the fragment and made the cursor land
      // short of the real boundary.
      let pos = end;
      let carry = Buffer.alloc(0);
      let turns: ExternalTranscriptTurn[] = [];
      let bytesRead = 0;
      let cursorOut: number | null = null;
      let hitCap = false;

      while (pos > 0) {
        if (bytesRead >= MAX_PAGE_BYTES) {
          hitCap = true;
          break;
        }
        const wantLen = Math.min(CHUNK_BYTES, pos);
        const nextPos = pos - wantLen;
        const buf = Buffer.alloc(wantLen);
        readSync(fd, buf, 0, wantLen, nextPos);
        bytesRead += wantLen;
        // `buf` (older bytes) then `carry` (the newer, previously-unresolved
        // fragment) — concatenated in correct file order (older first).
        // `combined` STARTS at file position `nextPos` (this matters for
        // every offset computed from it below).
        const combined = Buffer.concat([buf, carry]);
        pos = nextPos;

        if (pos > 0) {
          const nl = combined.indexOf(0x0a); // byte-accurate newline search
          if (nl === -1) {
            // Still no complete line at the OLDEST edge of this window —
            // keep the whole thing as carry and read further back. Not
            // re-parsed until a newline actually shows up.
            carry = combined;
            continue;
          }
          // The fragment BEFORE the newline is still unresolved — its true
          // start may be further back still. Carried forward (not
          // discarded, see the fix note above) so the NEXT read prepends
          // even-older bytes to it instead of losing it.
          carry = combined.subarray(0, nl);
          const usable = combined.subarray(nl + 1).toString('utf8');
          // Byte offset right after the dropped/carried fragment — NOT
          // `nextPos` (the original D12 bug): a cursor of `nextPos` would
          // skip past those bytes forever. This boundary means the NEXT
          // PAGE's window (reading backward FROM this point) still covers
          // them as its own trailing edge, same as `carry` does within this
          // same page's own loop.
          cursorOut = nextPos + nl + 1;
          const parsed = parseLines(usable);
          turns = [...parsed, ...turns];
          if (turns.length >= TARGET_TURNS_PER_PAGE) break;
        } else {
          // Reached the start of the file within this very read — nothing
          // precedes `combined` in the file, so the ENTIRE thing (including
          // any carried fragment) is now resolvable.
          const parsed = parseLines(combined.toString('utf8'));
          turns = [...parsed, ...turns];
          cursorOut = null;
          carry = Buffer.alloc(0);
        }
      }

      if (hitCap && cursorOut === null) {
        // MAX_PAGE_BYTES reached mid-scan (D12) before ever resolving a
        // single newline (a pathological run with none) — resume right
        // after the still-unresolved carry fragment, which starts at `pos`
        // (bug #2 fix: the previous version unconditionally overwrote a
        // perfectly good, already-resolved `cursorOut` with a bare `pos`
        // here; now it's left alone whenever one was already found above,
        // and this fallback only ever applies when there is none).
        cursorOut = carry.length > 0 ? pos + carry.length : pos > 0 ? pos : null;
      }

      return { turns, cursor: cursorOut, tailOffset: size };
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
