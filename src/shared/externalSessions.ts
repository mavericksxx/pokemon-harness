/** External sessions (docs/external-sessions-plan.md) — types shared between
 *  main and renderer for the "Other sessions" list, the read-only chat
 *  preview, and continuing a session started outside Pokéharness (Claude
 *  Desktop's Code tab, or the plain `claude` CLI). Dependency-free, like
 *  every other file under shared/. */

/** Where a transcript's OWN entrypoint places it — joined against the
 *  Desktop `local_*.json` sidecar when one exists (see
 *  main/externalSessions.ts's header). */
export type ExternalSessionSource = 'desktop' | 'cli';

/** One row for the agent sidebar's "Other sessions" section — everything the
 *  list needs to render without re-reading the transcript. */
export interface ExternalSessionSummary {
  /** The Claude Code conversation id (the transcript's own `.jsonl` basename,
   *  same value `--resume <id>` takes). */
  id: string;
  /** Absolute path to the top-level transcript file this row was built from. */
  transcriptPath: string;
  title: string;
  cwd: string;
  /** Repo basename, when `cwd` resolves inside a git work tree; otherwise
   *  `cwd`'s own basename. */
  repoName: string;
  gitBranch?: string;
  source: ExternalSessionSource;
  model?: string;
  permissionMode?: string;
  /** Epoch ms of the transcript's last write (mtime) — "last active". */
  lastActiveAt: number;
  createdAt: number;
  /** True when a live `claude` process (this app's own PTYs excluded) is
   *  currently attached to this conversation id, per
   *  `~/.claude/sessions/<pid>.json` — drives the green dot. */
  live: boolean;
}

export interface ExternalSessionsListResult {
  sessions: ExternalSessionSummary[];
}

/** One normalized chat turn for the read-only preview (`TranscriptView`).
 *  Tool calls are collapsed to a single descriptive line ("Edited
 *  src/foo.ts", "Ran: npm test") — never rendered as raw tool_use/tool_result
 *  JSON. */
export type ExternalTranscriptTurn =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string }
  | { kind: 'tool'; id: string; at: number; summary: string };

/** One page of turns, oldest-first within the page. `cursor` feeds back into
 *  `externalSessions:readTranscript` to fetch the NEXT (older) page; `null`
 *  once the top of the file has been reached. Every open re-reads the file
 *  fresh (plan §7) — the cursor is a byte offset into the CURRENT file, never
 *  cached across opens. */
export interface ExternalTranscriptPage {
  turns: ExternalTranscriptTurn[];
  /** Byte offset to pass back for the next (older) page, or null at BOF. */
  cursor: number | null;
  /** Byte offset immediately after the last byte this page consumed —
   *  callers use this as the starting tail offset for `subscribe`, so a live
   *  tail started right after the initial load never re-emits page content. */
  tailOffset: number;
}

/** Metadata `externalSessions:continueInfo` returns for the "Continue
 *  session" dialog — the outside session's cwd/model/mode, plus whether the
 *  cwd (and the transcript itself) still exist. */
export interface ExternalContinueInfo {
  id: string;
  title: string;
  cwd: string;
  cwdExists: boolean;
  transcriptExists: boolean;
  model?: string;
  permissionMode?: string;
  source: ExternalSessionSource;
}
