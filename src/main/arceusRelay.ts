/**
 * ArceusRelayWatcher — BACKLOG "next up" item 3: "tell chikorita to do X"
 * routing.
 *
 * Watches Arceus's OWN transcript for a structured relay directive in his
 * replies, resolves the named agent against the live session list, and
 * types the relayed instruction into that session's own pty — exactly like
 * real user input in that session's terminal (write + `\r`, same mechanism
 * pty:write / ArceusDispatchBox already use).
 *
 * Reads the TRANSCRIPT (clean JSONL, one complete assistant message per
 * line) rather than scraping raw pty bytes. Same tailing mechanism as
 * costWatcher.ts (poll by byte offset, carry a torn trailing line to the
 * next poll, restart from scratch if the file shrinks) — see that file's
 * header for why polling instead of `fs.watch`. Confirmed against a real
 * transcript on disk that a `type: "assistant"` line's `message.content` is
 * an array of content blocks, a `{type:"text", text}` block among them for
 * plain reply prose — `extractAssistantText` below reads exactly that.
 *
 * Chosen over scraping Arceus's raw pty output (the app's other precedent,
 * ptyParser.ts) because relay injection is NOT idempotent: typing into a
 * session's terminal twice for one real directive is a user-visible bug, and
 * a raw pty stream can repaint old content (resize, scrollback redraw) that
 * is indistinguishable from genuinely new output — there would be no way to
 * tell "Claude repainted an old reply" from "Arceus said something new"
 * without a fragile dedup heuristic. Each transcript line is written to disk
 * exactly once, so that whole class of false-positive re-delivery doesn't
 * exist here.
 *
 * Directive grammar (mirrored in agents/arceus/SYSTEM.md — shared/arceus.ts's
 * `ARCEUS_SYSTEM_PROMPT_TEMPLATE`): one or more, each its own line, of
 *   @@relay agent="<session title or pokémon species>" message="<instruction>"
 * `"` inside a value is escaped as `\"`, a literal backslash as `\\`.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { WebContents } from 'electron';
import { ARCEUS_SESSION_ID } from '../shared/arceus';
import { InjectionQueue } from '../shared/injectionQueue';
import type { PtyResult, SessionRecord } from '../shared/types';
import { log } from './diagnostics';

const POLL_MS = 2_000;

/** Sensible cap on a single relayed message (item 6's "cap directive message
 *  length sensibly") — generous for a real instruction, small enough to stop
 *  a pathological wall of text from getting typed into someone's terminal. */
const MAX_MESSAGE_LEN = 4_000;

/** Per-target cap on queued-while-busy relays, so a chatty Arceus relaying
 *  repeatedly to one stuck session can't grow this without bound. Oldest
 *  drops first. */
const MAX_QUEUE_PER_TARGET = 20;

const RELAY_RE = /@@relay\s+agent="((?:[^"\\]|\\.)*)"\s+message="((?:[^"\\]|\\.)*)"/g;

function unescapeField(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** Collapse any embedded whitespace (including a literal newline — a wrapped
 *  visual line in Arceus's own reply, or just multi-line prose inside the
 *  quotes) into single spaces, and trim. A raw newline written into a
 *  target's pty would submit early, so both `agent` and `message` are
 *  normalized before this ever reaches an injection. */
function normalizeField(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export interface RelayDirective {
  agent: string;
  message: string;
}

/** Pure — extracts every `@@relay agent="..." message="..."` occurrence from
 *  a block of text. Exercised from a plain script (never a real spawn), same
 *  convention as sessionRespawn.ts's pure functions. Tolerant of an embedded
 *  literal newline inside either quoted field (a wrapped reply line) since
 *  `[^"\\]` matches it; both captured fields are unescaped and whitespace-
 *  normalized before being returned, so callers never see a raw `\n`. Skips
 *  a match whose agent or message is empty after normalizing. */
export function parseRelayDirectives(text: string): RelayDirective[] {
  const out: RelayDirective[] = [];
  RELAY_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = RELAY_RE.exec(text)) !== null; ) {
    const agent = normalizeField(unescapeField(m[1]));
    const message = normalizeField(unescapeField(m[2]));
    if (agent && message) out.push({ agent, message });
  }
  return out;
}

/** Pure — resolves a directive's `agent` field against the live roster.
 *  Case-insensitive session-title match first (first hit wins if titles
 *  collide — not enforced unique elsewhere in this app); failing that, the
 *  pokémon species id as an alias, but ONLY when exactly one live,
 *  non-Arceus candidate carries it (an ambiguous species alias resolves to
 *  nothing rather than guessing). A 'done' session is excluded — its pty is
 *  already dead. */
export function resolveRelayTarget(name: string, sessions: SessionRecord[]): SessionRecord | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const candidates = sessions.filter((s) => !s.isArceus && !s.isPlainTerminal && s.status !== 'done');

  const byTitle = candidates.find((s) => s.title.trim().toLowerCase() === needle);
  if (byTitle) return byTitle;

  const bySpecies = candidates.filter((s) => s.pokemon.toLowerCase() === needle);
  return bySpecies.length === 1 ? bySpecies[0] : null;
}

/** `message.content` shape confirmed against a real on-disk transcript
 *  (`~/.claude/projects/<project>/<session-id>.jsonl`): an array of content blocks, a
 *  `{type:"text", text}` block among them for plain reply prose (alongside
 *  `thinking`/`tool_use` blocks this app has no use for here). Falls back to
 *  a bare string for robustness — costWatcher.ts's own header notes this
 *  shape is untyped upstream. Multiple text blocks (uncommon) are joined. */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

interface TrackedTranscript {
  path: string;
  /** Byte offset already consumed. */
  offset: number;
  /** Trailing partial line from the last read, prefixed onto the next one. */
  carry: string;
}

export class ArceusRelayWatcher {
  private tracked: TrackedTranscript | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-target idle-queue + injection (item 3's "queue the injection until
   *  that session next goes idle") — the shared helper (shared/injectionQueue.ts)
   *  BACKLOG phase E's focus-mode composer also builds on, so the safety
   *  rail (never inject into a non-idle session) lives in exactly one place.
   *  Flushed from `onSessionsChecked`. */
  private queue: InjectionQueue<string>;

  constructor(
    private writePty: (id: string, data: string) => PtyResult,
    private getSessions: () => SessionRecord[],
    private getWebContents: () => WebContents | null
  ) {
    this.queue = new InjectionQueue<string>(this.writePty, MAX_QUEUE_PER_TARGET, (message) => message, {
      onDropOldest: (targetId) =>
        log('arceus-relay', 'warn', 'relay queue full for target — dropping oldest', { targetId }),
      onDeliver: (target, _item, res) =>
        log('arceus-relay', 'info', res.ok ? 'relay delivered' : 'relay delivery failed', {
          targetId: target.id,
          title: target.title,
          ok: res.ok,
          error: res.error
        })
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** HookBridge's onRawPayload — same signature as CostWatcher's
   *  `onHookPayload`, chained alongside it in main/index.ts. No-ops for any
   *  session but Arceus's own fixed id: this watcher exists to read what
   *  Arceus says, not what any other session does. */
  onHookPayload(agentId: string, transcriptPath: string | undefined): void {
    if (agentId !== ARCEUS_SESSION_ID || !transcriptPath) return;
    if (this.tracked && this.tracked.path === transcriptPath) return;
    // A NEW transcript path for Arceus (fresh summon, or a resume that
    // landed on a different session id) starts tailing from the file's
    // CURRENT size, not byte 0 — deliberately UNLIKE costWatcher's
    // registerSession, which replays whole. Cost accumulation is idempotent
    // to re-derive from scratch; relay injection is not (that's the whole
    // reason this watcher reads the transcript instead of scraping pty
    // output — see this file's header). A `--resume` respawn points this at
    // an EXISTING transcript carrying the full prior conversation; replaying
    // from 0 would re-parse and re-inject every `@@relay` Arceus ever sent
    // in that conversation into whichever targets happen to be idle right
    // now. Starting at the current size only ever misses a directive from
    // the brief window before the first hook payload arrives — impossible on
    // a fresh summon, since SessionStart fires before Arceus's first turn.
    // A stale queue from a previous Arceus life is dropped too: nothing left
    // to resolve those against once he's a new process.
    let size = 0;
    try {
      size = statSync(transcriptPath).size;
    } catch {
      /* not written yet — starts at 0, nothing to skip */
    }
    this.tracked = { path: transcriptPath, offset: size, carry: '' };
    this.queue.clear();
  }

  /** Called from main/index.ts's `sessions:checkpoint` handler, right after
   *  `sessionRegistry` is updated — flushes any queued relay for a target
   *  that is now idle. Also drops a queue entry for a target that no longer
   *  exists (session closed) or has gone 'done' (its pty is dead) instead of
   *  holding it forever. Safety rail (item 6): only 'idle' ever flushes —
   *  'blocked' (which this app's Notification hook can't yet tell apart from
   *  a real permission prompt — see BACKLOG's "needs you over-triggers")
   *  stays queued, same as at first-resolve time in `handleDirective`. */
  onSessionsChecked(sessions: SessionRecord[]): void {
    this.queue.flush(sessions);
  }

  private poll(): void {
    const t = this.tracked;
    if (!t) return;

    let size: number;
    try {
      size = statSync(t.path).size;
    } catch {
      return; // not written yet, or gone — retry next tick
    }
    if (size < t.offset) {
      // Rotated/truncated — restart from scratch rather than reading garbage.
      t.offset = 0;
      t.carry = '';
    }
    if (size === t.offset) return; // nothing new

    let fd: number;
    try {
      fd = openSync(t.path, 'r');
    } catch {
      return;
    }
    let chunk: string;
    try {
      const len = size - t.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, t.offset);
      t.offset = size;
      chunk = t.carry + buf.toString('utf8');
    } finally {
      closeSync(fd);
    }

    const lines = chunk.split('\n');
    t.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.applyLine(line);
    }
  }

  private applyLine(line: string): void {
    let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      return; // a torn line read mid-write — will re-parse cleanly once complete
    }
    // Sidechain-marked lines belong to a SUBAGENT's own interleaving (same
    // exclusion costWatcher.ts applies) — Arceus's own reply text never has
    // one, but excluding it keeps a stray `@@relay`-shaped string inside a
    // subagent's transcript sidechain from ever being read as a directive.
    if (entry.type !== 'assistant' || entry.isSidechain === true) return;
    const text = extractAssistantText(entry.message?.content);
    if (!text) return;
    for (const directive of parseRelayDirectives(text)) this.handleDirective(directive);
  }

  private handleDirective(d: RelayDirective): void {
    const target = resolveRelayTarget(d.agent, this.getSessions());
    if (!target) {
      log('arceus-relay', 'warn', 'relay target did not resolve', { agent: d.agent });
      this.notifyUnresolved(d.agent);
      return;
    }

    let message = d.message;
    if (message.length > MAX_MESSAGE_LEN) {
      log('arceus-relay', 'warn', 'relay message truncated', {
        agent: d.agent,
        targetId: target.id,
        originalLength: d.message.length
      });
      message = message.slice(0, MAX_MESSAGE_LEN);
    }

    // Safety rail (item 6): only inject while the target is genuinely idle
    // at a prompt — 'working'/'starting'/'blocked' all queue instead. This
    // app's session status doesn't currently distinguish a real permission
    // prompt from a plain idle nudge (both collapse to 'blocked' — see
    // hookRouter.ts's Notification case and BACKLOG's "needs you
    // over-triggers"), so treating everything but 'idle' as unsafe to type
    // into is the conservative choice that holds either way. Enforced inside
    // `InjectionQueue.submit` itself now (shared/injectionQueue.ts) — this
    // call site only adds the `agent` field the shared queue's own log hooks
    // don't have access to.
    const result = this.queue.submit(target, message + '\r');
    if (result === 'queued') {
      log('arceus-relay', 'info', 'relay queued — target not idle', {
        agent: d.agent,
        targetId: target.id,
        status: target.status
      });
    }
  }

  private notifyUnresolved(name: string): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send('arceus:relayUnresolved', name);
    } catch {
      /* window tore down mid-send */
    }
  }
}
