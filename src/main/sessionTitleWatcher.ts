/**
 * SessionTitleWatcher — picks up Claude Code's own `/rename <name>` slash
 * command (a real CLI feature, nothing built on the CLI side) and pushes the
 * new name into `session.title`. One-directional only: Claude's `/rename` ->
 * Pokeharness's title, never the reverse.
 *
 * Mechanism (confirmed on disk, not from docs): running `/rename <name>`
 * inside a live claude session writes
 *   ~/.claude/projects/<project-dir-slug>/<claudeSessionId>/custom-title.json
 * containing exactly `{"customTitle":"<name>"}`. Note the layout: the
 * session's OWN transcript file lives FLAT as
 * `<project-dir-slug>/<claudeSessionId>.jsonl`, but `custom-title.json`
 * lives one level deeper, in a subdirectory named after the session id.
 *
 * Registration mirrors costWatcher.ts's own pattern: fed off every hook
 * payload's `transcript_path` (hookBridge.ts's `onRawPayload`), independent
 * of any one hook event, idempotent per agentId/path pair — see
 * `registerSession`'s own comment for the same stale-registration reset this
 * shares with costWatcher.ts/taskNotificationWatcher.ts (a `/clear` or a
 * resume replacing the transcript out from under an already-tracked
 * agentId). Unlike costWatcher this needs no byte-offset tailing —
 * `custom-title.json` is a small whole-file JSON blob, re-read in full on
 * every change rather than tailed.
 *
 * Read trigger: `fs.watch` on the PARENT directory
 * (`<project-dir-slug>/<claudeSessionId>/`), not the file itself — that file
 * (and even its containing directory, which the CLI creates lazily on the
 * first rename) may not exist yet at registration time, and `fs.watch`
 * throws synchronously on a path that doesn't exist yet. Watching the
 * directory survives the file itself not existing; events are filtered to
 * the `custom-title.json` filename. A FALLBACK_POLL_MS safety net (same
 * cadence/reasoning as costWatcher.ts's own) covers both a missed fs event
 * and the window before the directory itself gets created — the poll also
 * doubles as the retry for setting up the directory watch once it appears.
 *
 * Unlike costWatcher.ts/taskNotificationWatcher.ts, the fallback timer here
 * is NOT gated on any tracked session being `'working'`: a rename can happen
 * at any point in a live session, not just mid-turn, so it simply runs
 * whenever at least one session is registered.
 *
 * CLAUDE_DESKTOP_MARKER (👾 prefix — extends the above, same file, same
 * watch loop, to avoid a write/detect race between two independent watchers
 * on the same path): Claude Desktop (the separate, unrelated app) reads this
 * exact `custom-title.json` file for ITS OWN session list display. To make a
 * Pokeharness-started session easy to spot there, this watcher stamps every
 * `customTitle` it writes with a `👾 ` prefix — but that prefix must NEVER
 * reach Pokeharness's own UI (`session.title` stays plain). So:
 *  - A brand-new session (no `custom-title.json` at registration) gets one
 *    written immediately, `👾 <current Pokeharness title>` — see
 *    `tryInitialMark`.
 *  - Any raw `customTitle` this watcher reads that DOES start with the
 *    marker has it stripped before ever reaching `checkAndEmit`'s emit path
 *    — Pokeharness's own UI only ever sees the stripped value.
 *  - Any raw `customTitle` that does NOT start with the marker (a genuine
 *    user `/rename` typed straight into the CLI, which has no reason to
 *    know about this app's own marker) is treated as the marker having been
 *    dropped: this watcher restores it on disk (`👾 ` + the raw value) so
 *    Claude Desktop keeps showing it, while immediately emitting the RAW
 *    (unprefixed) value to Pokeharness's own UI — see `restoreMarker`'s own
 *    comment for why the restoring write's own fs.watch/poll round-trip is
 *    guaranteed to be a single harmless no-op hop, never a rewrite loop.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { WebContents } from 'electron';

/** Safety-net poll cadence — mirrors costWatcher.ts's own constant/reasoning. */
const FALLBACK_POLL_MS = 30_000;

/** Prefix (emoji + one space) this watcher stamps into `custom-title.json`'s
 *  `customTitle` for Claude Desktop's own benefit — see this file's header.
 *  Never surfaced to Pokeharness's own UI. */
const CLAUDE_DESKTOP_MARKER = '👾 ';

/** Parses `raw` (the whole `custom-title.json` file's text) into its
 *  `customTitle` string, or `null` for anything that isn't a usable
 *  non-empty string — malformed/torn JSON (a race with the CLI mid-write)
 *  included. Trimmed (only the overall string's leading/trailing
 *  whitespace — an internal marker/name boundary space is never touched). */
function parseCustomTitle(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { customTitle?: unknown };
    const title = parsed.customTitle;
    if (typeof title !== 'string') return null;
    const trimmed = title.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null; // torn write mid-save — retry next tick/event
  }
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // not written yet, or gone
  }
}

/** Atomic (tmp+rename) write, mirroring sessionPersistence.ts's own
 *  `writeNow` — creates the parent directory first, since a brand-new
 *  session's `<claudeSessionId>/` subdirectory may not exist yet (normally
 *  created lazily by the CLI on the first `/rename`; this watcher itself is
 *  the first writer for the initial 👾 stamp). Best-effort: never throws
 *  into a caller that must stay watcher-safe. */
function writeCustomTitleAtomic(path: string, customTitle: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ customTitle }), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // retried next tick if still needed (see needsInitialMark)
  }
}

interface TrackedSession {
  transcriptPath: string;
  customTitlePath: string;
  /** `dirname(customTitlePath)` — what actually gets `fs.watch`ed. */
  watchDir: string;
  lastEmittedTitle: string | null;
  /** Exact raw file bytes last processed — short-circuits reprocessing
   *  (parsing, and a possible marker-restore rewrite) on a poll tick where
   *  the file's content hasn't actually changed since the last read. */
  lastRawSeen: string | null;
  /** True while this session is still waiting for its initial 👾-marked
   *  `custom-title.json` to be written — a brand-new session (no file at
   *  registration time) whose current Pokeharness title wasn't known yet
   *  (a rare renderer/hook-timing race). Retried from `pollAll` until it
   *  succeeds, or until the file shows up some other way (a real rename beat
   *  it there, which the normal read/restore path already handles like any
   *  other content). */
  needsInitialMark: boolean;
}

export class SessionTitleWatcher {
  private sessions = new Map<string, TrackedSession>();
  /** Per-tracked-session `fs.watch` handle on `watchDir` — the primary read
   *  trigger. Kept in lockstep with `sessions`: set up in `registerSession`
   *  (or retried from `pollAll` if the directory didn't exist yet), torn
   *  down in `unregisterSession` and on a reset (path change) in
   *  `registerSession`. */
  private watchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Whether `start()`/`stop()` currently permit the timer to run at all. */
  private armed = false;

  /** `getSessionTitle` — same late-bound main-process lookup pattern
   *  main/pokeTools.ts's `PokeRelay` constructor uses for its own
   *  `getSessions` param (wired from main/index.ts's `() => sessionRegistry`),
   *  narrowed to just
   *  the one field this watcher needs: a session's CURRENT Pokeharness
   *  title, read once per brand-new session to stamp the initial 👾 marker
   *  (see `tryInitialMark`). */
  constructor(
    private getWebContents: () => WebContents | null,
    private getSessionTitle: (agentId: string) => string | undefined
  ) {}

  start(): void {
    this.armed = true;
    this.reconcileTimer();
  }

  stop(): void {
    this.armed = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers.clear();
  }

  private reconcileTimer(): void {
    if (!this.armed) return;
    const shouldRun = this.sessions.size > 0;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => this.pollAll(), FALLBACK_POLL_MS);
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Sets up the `fs.watch` for a tracked session's `watchDir`. Best-effort,
   *  same as costWatcher.ts's own `watchPath`: the directory may not exist
   *  yet (created lazily by the CLI on the first rename) — that case, and any
   *  platform that can't watch it, just leaves reads to the FALLBACK_POLL_MS
   *  safety net (which also retries this call once the directory shows up —
   *  see `pollAll`). */
  private watchDirFor(agentId: string, s: TrackedSession): void {
    this.unwatchDir(agentId);
    if (!existsSync(s.watchDir)) return;
    try {
      const targetName = basename(s.customTitlePath);
      const watcher = watch(s.watchDir, (_event, filename) => {
        // `filename` isn't guaranteed on every platform — when absent, check
        // anyway rather than silently dropping the event.
        if (filename && filename !== targetName) return;
        // This watcher may already be stale by the time its callback fires
        // (closed by a reset/unregister that raced it, since `close()` still
        // lets an already-queued event through) — re-check against the live
        // map rather than trusting the captured `s`, same as costWatcher.ts/
        // taskNotificationWatcher.ts's own callbacks routing through
        // `pollOne(agentId)`'s fresh `this.sessions.get(agentId)` lookup.
        if (this.sessions.get(agentId) !== s) return;
        this.checkAndEmit(agentId, s);
      });
      watcher.on('error', () => this.unwatchDir(agentId));
      this.watchers.set(agentId, watcher);
    } catch {
      /* directory vanished between the existsSync check and here, or
       * platform can't watch it — fallback poll covers it */
    }
  }

  private unwatchDir(agentId: string): void {
    const watcher = this.watchers.get(agentId);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
    this.watchers.delete(agentId);
  }

  /** Registers (or no-ops if already registered against the SAME transcript
   *  path) a session. Safe to call repeatedly/redundantly, same as
   *  costWatcher.ts's `registerSession` — including its 2026-09-06 stale-
   *  registration reset: an agentId already tracked against a DIFFERENT
   *  transcript path means the CLI session under it was replaced without an
   *  explicit `unregisterSession` ever firing (`/clear`, or Arceus's
   *  `tryResumeArceus`). Only reset when `hookEventName` is a genuine
   *  top-level `SessionStart` AND `subagentAgentId` is unset — a subagent-
   *  scoped payload must never thrash the parent's tracked registration (see
   *  costWatcher.ts's own comment for the full reasoning, shared verbatim
   *  here).
   *
   *  Unlike costWatcher.ts's own reset, this deliberately does NOT emit a
   *  cleared/default title on reset — there is no "zeroed" title to be
   *  truthful about the way costWatcher's zeroed numbers are; the renderer's
   *  existing title (whether default or a prior `/rename`) simply stays
   *  until this session's own `custom-title.json` (if any) is read. A reset
   *  onto a brand-new transcript (e.g. `/clear`) DOES get a brand-new 👾
   *  stamp, though — see the `needsInitialMark` block below, which treats
   *  "no `custom-title.json` yet" identically whether this is a session's
   *  very first registration or a reset onto a fresh transcript. */
  registerSession(
    agentId: string,
    transcriptPath: string | undefined | null,
    hookEventName?: string,
    subagentAgentId?: string
  ): void {
    if (!transcriptPath) return;
    const existing = this.sessions.get(agentId);
    if (existing) {
      if (existing.transcriptPath === transcriptPath) return; // harmless no-op — path unchanged
      if (subagentAgentId || hookEventName !== 'SessionStart') return;
      this.sessions.delete(agentId);
      this.unwatchDir(agentId);
    }

    const dir = dirname(transcriptPath);
    const claudeSessionId = basename(transcriptPath, '.jsonl');
    const customTitlePath = join(dir, claudeSessionId, 'custom-title.json');
    const s: TrackedSession = {
      transcriptPath,
      customTitlePath,
      watchDir: dirname(customTitlePath),
      lastEmittedTitle: null,
      lastRawSeen: null,
      needsInitialMark: false
    };
    this.sessions.set(agentId, s);

    if (!existsSync(customTitlePath)) {
      // Brand-new session (never renamed, and not a resume of one this
      // watcher already marked) — stamp Claude Desktop's own 👾 marker up
      // front, before any real rename ever happens. No emission needed:
      // Pokeharness's own title is already correct, it's literally where
      // `getSessionTitle` reads it from.
      s.needsInitialMark = true;
      this.tryInitialMark(agentId, s);
    }

    // Immediate check: a resumed/reattached session may already carry a
    // title from an earlier run's `/rename`, before this watcher ever saw
    // it — don't wait for a fresh rename to surface it. (A no-op if
    // `tryInitialMark` just wrote the file above — see its own comment for
    // why that pre-seeds the dedupe state this reads.)
    this.checkAndEmit(agentId, s);
    this.watchDirFor(agentId, s);
    this.reconcileTimer();
  }

  unregisterSession(agentId: string): void {
    this.sessions.delete(agentId);
    this.unwatchDir(agentId);
    this.reconcileTimer();
  }

  /** Hook payload observer — see hookBridge.ts's `onRawPayload` constructor
   *  param (same chaining point costWatcher.ts/taskNotificationWatcher.ts
   *  use). */
  onHookPayload(
    agentId: string,
    transcriptPath: string | undefined,
    hookEventName?: string,
    subagentAgentId?: string
  ): void {
    this.registerSession(agentId, transcriptPath, hookEventName, subagentAgentId);
  }

  /** Writes the initial `👾 <title>` `custom-title.json` for a session that
   *  didn't have one at registration time. A no-op once `needsInitialMark`
   *  is false (either this already succeeded, or a real rename beat it to
   *  the file). If `getSessionTitle` doesn't have an answer yet (the
   *  renderer's own session-registry checkpoint hasn't caught up with this
   *  hook payload — see this class's constructor comment), or the write
   *  itself fails, `needsInitialMark` stays true and `pollAll` retries. */
  private tryInitialMark(agentId: string, s: TrackedSession): void {
    if (!s.needsInitialMark) return;
    if (existsSync(s.customTitlePath)) {
      // Beaten to it — a real rename (or an earlier run's own mark)
      // already created the file. Let the normal read path handle it.
      s.needsInitialMark = false;
      return;
    }
    const title = this.getSessionTitle(agentId)?.trim();
    if (!title) return; // not known yet (or blank) — retried next poll tick
    const markedTitle = CLAUDE_DESKTOP_MARKER + title;
    if (!writeCustomTitleAtomic(s.customTitlePath, markedTitle)) return; // retried next poll tick
    s.needsInitialMark = false;
    // Pre-seed dedupe state to exactly what's now on disk, so the
    // `checkAndEmit` call right after this one (in `registerSession`, and
    // any fs.watch event this very write triggers) is a clean no-op —
    // Pokeharness's own UI already shows `title`, it's where this came from.
    s.lastRawSeen = JSON.stringify({ customTitle: markedTitle });
    s.lastEmittedTitle = title;
  }

  private pollAll(): void {
    for (const [agentId, s] of this.sessions) {
      if (s.needsInitialMark) this.tryInitialMark(agentId, s);
      // A watched directory that disappears doesn't always fire `fs.watch`'s
      // `error` event (observed quiet on macOS/FSEvents) — drop a stale
      // handle here so the retry below actually re-attempts it instead of
      // leaving a dead watcher parked in the map forever.
      if (this.watchers.has(agentId) && !existsSync(s.watchDir)) this.unwatchDir(agentId);
      // Retry setting up the directory watch in case it didn't exist yet at
      // registration time (or a previous watch errored out) — the directory
      // demonstrably existing is checked inside `watchDirFor` itself.
      if (!this.watchers.has(agentId)) this.watchDirFor(agentId, s);
      this.checkAndEmit(agentId, s);
    }
  }

  /** Reads and reacts to `custom-title.json`'s CURRENT content — the shared
   *  entry point for both the fs.watch trigger and the fallback poll.
   *  Dedupes on the RAW file bytes first (not just the parsed/emitted
   *  title), so a poll tick where nothing on disk changed is a single cheap
   *  read-and-compare, never a reparse or a disk write.
   *
   *  Two cases once a genuinely new raw value is seen (see this file's
   *  header for the full 👾-marker design):
   *   - Already carries `CLAUDE_DESKTOP_MARKER`: strip it and emit the
   *     stripped value to the renderer if it changed. Never rewrites the
   *     file — it's already correct.
   *   - Missing the marker: `restoreMarker` handles it. */
  private checkAndEmit(agentId: string, s: TrackedSession): void {
    const raw = readRaw(s.customTitlePath);
    if (raw === null || raw === s.lastRawSeen) return;
    s.lastRawSeen = raw;

    const title = parseCustomTitle(raw);
    if (title === null) return; // malformed/empty — leave as-is, retry next tick/event

    if (title.startsWith(CLAUDE_DESKTOP_MARKER)) {
      const stripped = title.slice(CLAUDE_DESKTOP_MARKER.length).trim();
      if (!stripped || stripped === s.lastEmittedTitle) return;
      s.lastEmittedTitle = stripped;
      this.emit(agentId, stripped);
      return;
    }

    this.restoreMarker(agentId, s, title);
  }

  /** The marker is missing from `title` (already the raw, unprefixed
   *  value) — a genuine user `/rename` typed straight into the CLI (it has
   *  no reason to know about this app's own marker), or any other write to
   *  the file. Restores the marker on disk so Claude Desktop keeps showing
   *  it, and emits `title` itself to the renderer immediately (if it
   *  changed) rather than waiting for the write below to round-trip back
   *  through `checkAndEmit`.
   *
   *  It DOES round-trip — this write lands inside the very directory this
   *  watcher watches — but that second pass is a guaranteed single-hop
   *  no-op, never a rewrite loop: the re-read raw content now starts with
   *  the marker, so `checkAndEmit` takes its OTHER branch, computes
   *  `stripped` = `title` (unchanged), finds it already equals
   *  `lastEmittedTitle` (set right here before the write even happens), and
   *  returns without emitting — and that branch never writes to disk at
   *  all, so there is no third pass to reason about.
   *
   *  If the write itself fails, `s.lastRawSeen` is reset to `null` so the
   *  next poll/watch tick re-reads the (still-unmarked) file and retries the
   *  write — without this, `checkAndEmit`'s own raw-content dedupe (already
   *  updated to the unmarked bytes before this method ever runs) would
   *  otherwise treat the file as "unchanged" forever and the marker would
   *  never get restored. The re-read is safe to reprocess: `title` will
   *  already equal `lastEmittedTitle` by then, so it's a write-only retry,
   *  never a second emit. */
  private restoreMarker(agentId: string, s: TrackedSession, title: string): void {
    if (title !== s.lastEmittedTitle) {
      s.lastEmittedTitle = title;
      this.emit(agentId, title);
    }
    if (!writeCustomTitleAtomic(s.customTitlePath, CLAUDE_DESKTOP_MARKER + title)) {
      s.lastRawSeen = null;
    }
  }

  private emit(agentId: string, title: string): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(`session:title:${agentId}`, title);
    } catch {
      /* window tore down mid-send */
    }
  }
}
