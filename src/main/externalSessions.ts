/**
 * ExternalSessionsService — the "Other sessions" list (docs/external-sessions
 * -plan.md §7 step 1): Claude Code conversations started outside Pokéharness
 * (Claude Desktop's Code tab, or the plain `claude` CLI), scanned straight off
 * disk. Read-only — this file never writes a transcript or a hook socket.
 *
 * Store layout (§3): CLI and Desktop both write
 * `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, top-level only — a
 * subagent transcript nests one level deeper at `<uuid>/subagents/agent-*
 * .jsonl` and is skipped by construction (only `*.jsonl` directly inside a
 * project dir is considered, never a recursive walk).
 *
 * Metadata: the first <=50 lines carry `cwd`/`gitBranch`/`entrypoint`/
 * `version` and the first real user prompt (a plain typed one — meta/queue-
 * operation/attachment/command records don't count); the last 64 KB carries
 * `custom-title`/`ai-title`/`last-prompt` records, observed present near the
 * tail of every transcript sampled during design (§3). The sidecar
 * `<projectdir>/<uuid>/custom-title.json` (sessionTitleWatcher.ts's own
 * format) wins over both when present, since that's the same file a live
 * `/rename` writes.
 *
 * Desktop join: `~/Library/Application Support/Claude/claude-code-sessions/
 * <acct>/<org>/local_<uuid>.json` carries `cliSessionId`, `title`, `model`,
 * `permissionMode`, `isArchived`. Joined by `cliSessionId` == this
 * conversation's own id.
 *
 * Exclusions: `sdk-*` entrypoints, sidechain-only files, Desktop
 * `isArchived`, and Pokéharness's own sessions — "own" means either a live
 * `claudeSessionId` on any CURRENT SessionRecord, or a `custom-title.json`
 * whose title starts with the 👾 marker (sessionTitleWatcher.ts) — a closed
 * native session's transcript still carries that stamp, so it stays excluded
 * even after Pokéharness itself forgets about it.
 *
 * Liveness (green dot): `~/.claude/sessions/<pid>.json` — live means the pid
 * is actually alive, `procStart` matches the OS's own record of that pid's
 * start time (guards against pid reuse), and `updatedAt` is under 24h old.
 * See `isRegistryEntryLive`'s own comment for the exact procStart comparison
 * (loose on hour, to tolerate an observed timezone-formatting quirk between
 * the registry's own `Date.toString()` and `ps -o lstart=`'s output).
 *
 * Caching: per-file cache keyed by (path, mtime, size) — a file whose stat
 * hasn't changed since the last scan is never re-read. Concurrency-capped
 * async fs/promises scan, no child process (§7: "no child process unless
 * measured jank").
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ExternalSessionSummary, ExternalSessionSource } from '../shared/externalSessions';
import type { SessionRecord } from '../shared/types';

const execFileAsync = promisify(execFile);

const CLAUDE_DESKTOP_MARKER = '👾 ';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const DESKTOP_SESSIONS_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions'
);

const HEAD_LINES = 50;
const TAIL_BYTES = 64 * 1024;
/** How many files are stat'd/parsed at once during a scan — a project dir
 *  full of hundreds of transcripts must not open them all at the same time. */
const SCAN_CONCURRENCY = 8;
const LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface HeadMeta {
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  firstUserPrompt?: string;
  createdAt?: number;
  hasSidechain: boolean;
  sawAnyRecord: boolean;
}

interface TailMeta {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  lastActiveAt?: number;
}

interface DesktopRecord {
  cliSessionId: string;
  title?: string;
  model?: string;
  permissionMode?: string;
  isArchived?: boolean;
}

/** What's actually cached by (mtime, size) — the parsed head/tail metadata
 *  ONLY, never an own-id/👾/archived decision (2026-09-26 review, D1): those
 *  three depend on state that can change WITHOUT the jsonl file itself
 *  changing (the session registry gaining/losing a live claudeSessionId
 *  across a Continue; a custom-title.json sidecar written independently of
 *  the transcript; a Desktop `isArchived` flip) — caching the FINAL
 *  own/live/hidden decision by the jsonl's own (mtime, size) froze it stale:
 *  a session scanned while live stayed hidden forever after it closed, and
 *  a row cached as visible stayed listed after Continue, letting Continue
 *  be clicked twice onto the same conversation. `base: null` means
 *  PERMANENTLY excluded on structural grounds tied only to the jsonl's own
 *  content (no records parsed, `sdk-*` entrypoint, sidechain-only) — that
 *  part IS safe to cache by (mtime, size), since it can't change without the
 *  file itself changing. */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  base: { head: HeadMeta; tail: TailMeta } | null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function safeJsonParse<T>(line: string): T | null {
  // Undocumented, evolving format (§3/§5): tolerate unknown record shapes and
  // torn/partial lines rather than throwing.
  if (line.length > 200_000) return null; // guard against a pathological single line
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** Reads the first ~HEAD_LINES lines of `path` for cheap top-of-file
 *  metadata. Never reads the whole file. */
async function readHead(path: string): Promise<HeadMeta> {
  const meta: HeadMeta = { hasSidechain: false, sawAnyRecord: false };
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return meta;
  }
  try {
    // 64KB is comfortably more than 50 short JSONL lines in practice; if a
    // pathological file has huge head lines, this just reads a partial last
    // line, which safeJsonParse's per-line try/catch handles fine.
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n').slice(0, HEAD_LINES);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rec = safeJsonParse<Record<string, unknown>>(trimmed);
      if (!rec) continue;
      meta.sawAnyRecord = true;
      if (rec.isSidechain === true) meta.hasSidechain = true;
      if (typeof rec.cwd === 'string' && !meta.cwd) meta.cwd = rec.cwd;
      if (typeof rec.gitBranch === 'string' && !meta.gitBranch) meta.gitBranch = rec.gitBranch;
      if (typeof rec.entrypoint === 'string' && !meta.entrypoint) meta.entrypoint = rec.entrypoint;
      if (!meta.createdAt && typeof rec.timestamp === 'string') {
        const t = Date.parse(rec.timestamp);
        if (!Number.isNaN(t)) meta.createdAt = t;
      }
      if (!meta.firstUserPrompt && rec.type === 'user' && rec.isSidechain !== true) {
        const message = rec.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (typeof content === 'string' && content.trim()) {
          meta.firstUserPrompt = content.trim().slice(0, 200);
        }
      }
    }
  } catch {
    /* best-effort */
  } finally {
    await fh.close().catch(() => {});
  }
  return meta;
}

/** Reads the last TAIL_BYTES of `path` for `custom-title`/`ai-title`/
 *  `last-prompt` records, observed to sit near the tail (§3). */
async function readTail(path: string, size: number): Promise<TailMeta> {
  const meta: TailMeta = {};
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return meta;
  }
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rec = safeJsonParse<Record<string, unknown>>(trimmed);
      if (!rec) continue;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
        meta.customTitle = rec.customTitle;
      } else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
        meta.aiTitle = rec.aiTitle;
      } else if (rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') {
        meta.lastPrompt = rec.lastPrompt;
      }
      if (typeof rec.timestamp === 'string') {
        const t = Date.parse(rec.timestamp);
        if (!Number.isNaN(t)) meta.lastActiveAt = Math.max(meta.lastActiveAt ?? 0, t);
      }
    }
  } catch {
    /* best-effort */
  } finally {
    await fh.close().catch(() => {});
  }
  return meta;
}

/** Sidecar written by a live `/rename` (sessionTitleWatcher.ts's own format)
 *  — wins over both head/tail metadata when present. Returns the RAW title
 *  (marker not yet stripped) plus whether it carries the 👾 marker. */
async function readCustomTitleSidecar(
  projectDir: string,
  claudeSessionId: string
): Promise<{ raw: string; isOwn: boolean } | null> {
  const path = join(projectDir, claudeSessionId, 'custom-title.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { customTitle?: unknown };
    if (typeof parsed.customTitle !== 'string' || !parsed.customTitle.trim()) return null;
    const title = parsed.customTitle.trim();
    return { raw: title, isOwn: title.startsWith(CLAUDE_DESKTOP_MARKER) };
  } catch {
    return null;
  }
}

/** Loads every Desktop `local_*.json` sidecar under DESKTOP_SESSIONS_DIR,
 *  keyed by `cliSessionId`. Best-effort — an absent/unreadable Desktop
 *  install just means every row is source `cli`. */
async function loadDesktopRecords(): Promise<Map<string, DesktopRecord>> {
  const byId = new Map<string, DesktopRecord>();
  let accounts: string[];
  try {
    accounts = await readdir(DESKTOP_SESSIONS_DIR);
  } catch {
    return byId;
  }
  for (const acct of accounts) {
    const acctDir = join(DESKTOP_SESSIONS_DIR, acct);
    let orgs: string[];
    try {
      orgs = await readdir(acctDir);
    } catch {
      continue;
    }
    for (const org of orgs) {
      const orgDir = join(acctDir, org);
      let files: string[];
      try {
        files = await readdir(orgDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('local_') || !file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(orgDir, file), 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const cliSessionId = parsed.cliSessionId;
          if (typeof cliSessionId !== 'string') continue;
          byId.set(cliSessionId, {
            cliSessionId,
            title: typeof parsed.title === 'string' ? parsed.title : undefined,
            model: typeof parsed.model === 'string' ? parsed.model : undefined,
            permissionMode: typeof parsed.permissionMode === 'string' ? parsed.permissionMode : undefined,
            isArchived: parsed.isArchived === true
          });
        } catch {
          /* torn/unreadable — skip this one file */
        }
      }
    }
  }
  return byId;
}

/** Parses `~/.claude/sessions/<pid>.json`'s own `procStart` — a plain
 *  `Date.toString()`-shaped string like "Mon Sep 21 19:26:20 2026" — and
 *  compares it against `ps -o lstart=` for the SAME pid. An hour-level
 *  mismatch was observed between the two on this machine (almost certainly a
 *  timezone-formatting difference between whatever produced the registry
 *  file and `ps`'s own locale), so the comparison ignores the hour field and
 *  matches on weekday/month/day/year/minute/second — precise enough to catch
 *  actual pid reuse (a different process entirely started at a different
 *  minute) without false-negativing on the observed skew. */
function procStartLooseMatch(registryProcStart: string, psLstart: string): boolean {
  const re = /^(\w+ \w+ +\d+) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
  const a = registryProcStart.trim().match(re);
  const b = psLstart.trim().match(re);
  if (!a || !b) return false;
  // a[1] = "Mon Sep 21", a[5] = year; skip a[2] (hour)
  return a[1] === b[1] && a[5] === b[5] && a[3] === b[3] && a[4] === b[4];
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function psLstart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const line = stdout.trim();
    return line || null;
  } catch {
    return null;
  }
}

interface RegistryEntry {
  pid: number;
  sessionId: string;
  procStart?: string;
  updatedAt?: number;
}

/** Reads every `~/.claude/sessions/<pid>.json`, returning the set of
 *  conversation ids ("sessionId") with at least one genuinely live process
 *  attached — pid alive, procStart matches, updatedAt < 24h. Best-effort:
 *  an unreadable/absent directory just means nothing is live. */
async function liveConversationIds(): Promise<Set<string>> {
  const live = new Set<string>();
  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch {
    return live;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('.key'));
  await mapLimit(jsonFiles, SCAN_CONCURRENCY, async (file) => {
    try {
      const raw = await readFile(join(SESSIONS_DIR, file), 'utf8');
      const entry = JSON.parse(raw) as RegistryEntry;
      if (!entry.sessionId || typeof entry.pid !== 'number') return;
      if (entry.updatedAt && Date.now() - entry.updatedAt > LIVE_MAX_AGE_MS) return;
      if (!(await isPidAlive(entry.pid))) return;
      if (entry.procStart) {
        const real = await psLstart(entry.pid);
        if (!real || !procStartLooseMatch(entry.procStart, real)) return;
      }
      live.add(entry.sessionId);
    } catch {
      /* torn/unreadable registry file — skip */
    }
  });
  return live;
}

export class ExternalSessionsService {
  private cache = new Map<string, CacheEntry>(); // key: transcript path

  constructor(private getSessionRegistry: () => SessionRecord[]) {}

  async list(): Promise<ExternalSessionSummary[]> {
    const [projectDirs, desktopRecords, liveIds] = await Promise.all([
      this.listProjectDirs(),
      loadDesktopRecords(),
      liveConversationIds()
    ]);

    const ownClaudeSessionIds = new Set(
      this.getSessionRegistry()
        .map((s) => s.claudeSessionId)
        .filter((id): id is string => !!id)
    );

    const files: { dir: string; path: string }[] = [];
    for (const dir of projectDirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        if (name.startsWith('agent-')) continue; // top-level only (§7)
        files.push({ dir, path: join(dir, name) });
      }
    }

    const summaries = await mapLimit(files, SCAN_CONCURRENCY, ({ dir, path }) =>
      this.buildSummary(dir, path, desktopRecords, ownClaudeSessionIds, liveIds)
    );

    return summaries.filter((s): s is ExternalSessionSummary => s !== null);
  }

  private async listProjectDirs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(PROJECTS_DIR);
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const name of names) {
      const full = join(PROJECTS_DIR, name);
      try {
        const st = await stat(full);
        if (st.isDirectory()) dirs.push(full);
      } catch {
        /* raced away */
      }
    }
    return dirs;
  }

  private async buildSummary(
    dir: string,
    path: string,
    desktopRecords: Map<string, DesktopRecord>,
    ownIds: Set<string>,
    liveIds: Set<string>
  ): Promise<ExternalSessionSummary | null> {
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }

    const claudeSessionId = basename(path, '.jsonl');

    // Own-session exclusion — re-checked on EVERY call, cache or no cache
    // (D1): both the registry's live ids and the sidecar can change without
    // the jsonl itself changing (a Continue, or a fresh `/rename`), so
    // caching this decision by the jsonl's own (mtime, size) would freeze it
    // stale. The sidecar read is a single small file, cheap enough to redo
    // every list() alongside the (already per-call) desktop/registry reads.
    const sidecar = await readCustomTitleSidecar(dir, claudeSessionId);
    if (sidecar?.isOwn) return null;
    if (ownIds.has(claudeSessionId)) return null;

    let base: { head: HeadMeta; tail: TailMeta } | null;
    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      base = cached.base;
    } else {
      const head = await readHead(path);
      // Structural exclusions tied ONLY to the jsonl's own content — safe to
      // cache by (mtime, size), since they can't change without the file
      // itself changing.
      if (!head.sawAnyRecord || head.entrypoint?.startsWith('sdk-') || head.hasSidechain) {
        base = null;
      } else {
        const tail = await readTail(path, st.size);
        base = { head, tail };
      }
      this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, base });
    }
    if (!base) return null;
    const { head, tail } = base;

    // Desktop `isArchived` — also re-checked every call, not cached (D1):
    // `desktopRecords` is freshly loaded once per `list()` already.
    const desktop = desktopRecords.get(claudeSessionId);
    if (desktop?.isArchived) return null;

    const source: ExternalSessionSource = desktop || head.entrypoint === 'claude-desktop' ? 'desktop' : 'cli';

    const rawSidecarTitle = sidecar && !sidecar.isOwn ? sidecar.raw : undefined;
    const title =
      rawSidecarTitle ??
      desktop?.title ??
      tail.customTitle ??
      tail.aiTitle ??
      head.firstUserPrompt ??
      basename(dirname(path));

    const cwd = head.cwd ?? '';
    const repoName = basename(cwd.replace(/\/+$/, '')) || cwd || 'unknown';

    const summary: ExternalSessionSummary = {
      id: claudeSessionId,
      transcriptPath: path,
      title,
      cwd,
      repoName,
      gitBranch: head.gitBranch,
      source,
      model: desktop?.model,
      permissionMode: desktop?.permissionMode,
      lastActiveAt: tail.lastActiveAt ?? st.mtimeMs,
      createdAt: head.createdAt ?? st.birthtimeMs,
      live: liveIds.has(claudeSessionId)
    };

    return summary;
  }
}

/** `externalSessions:continueInfo` support — whether a conversation's cwd and
 *  transcript still exist, for the continue-dialog's own gating (plan §7:
 *  "verify the transcript exists before spawning"). */
export async function checkContinueTarget(
  transcriptPath: string,
  cwd: string
): Promise<{ cwdExists: boolean; transcriptExists: boolean }> {
  const [cwdExists, transcriptExists] = await Promise.all([
    access(cwd, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false),
    access(transcriptPath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false)
  ]);
  return { cwdExists, transcriptExists };
}
