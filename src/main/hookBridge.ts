/**
 * HookBridge — Claude Code lifecycle hooks shim (Phase 4 Part A).
 *
 * Port of munder-difflin's hive.ts/hooks.ts mechanism (MIT, Chaitanya Giri),
 * trimmed to this app's needs: no cost ledger, no HITL gating, no roster
 * injection — just a dumb, fast relay from a `claude` session's hooks to the
 * renderer, so the garden can treat hook events as the authoritative state
 * source instead of scraping terminal text.
 *
 * Mechanism: on a claude spawn, we write a per-session `settings.json` whose
 * `hooks` block runs a tiny generated Node shim (`cth-hook.cjs`) for every
 * wired event. The shim reads the hook's JSON payload on stdin, stamps it
 * with `POKEHARNESS_AGENT_ID` (set on the child's env — see pty.ts), and
 * forwards it over a Unix domain socket this class listens on. We normalize
 * the payload and push it to the renderer over `hooks:event:<agentId>`; the
 * shim always gets `{}` back (this app never denies/gates a tool call at the
 * hook boundary).
 *
 * The shim itself is invoked by Claude via a bare `sh -c` with a stripped
 * PATH — a plain `node "<script>"` command 127s on a machine whose node only
 * lives on an interactive shell's PATH (nvm, etc). Electron's own binary is a
 * full Node runtime under ELECTRON_RUN_AS_NODE=1, so we write a tiny wrapper
 * script that runs the shim through it, exactly like the reference's
 * `hive-node` launcher.
 */
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { log } from './diagnostics';
import {
  isKnownHookEvent,
  normalizeToolName,
  toolTargetFromInput,
  type DelegateHookSignal,
  type HookEvent,
  type HookPayload
} from '../shared/hookEvents';

/** Env var the shim reads to find the UDS to dial. */
export const HOOK_SOCK_ENV = 'POKE_HOOK_SOCK';
/** Env var the shim stamps onto every payload as `harness_agent_id`.
 *
 *  Namespaced as `POKEHARNESS_AGENT_ID` (not the bare `AGENT_ID` this used
 *  pre-BACKLOG-item-3): a live hook capture showed a subagent's tool-call
 *  hooks carrying a DIFFERENT value for `AGENT_ID` than the parent's,
 *  suggesting Claude Code itself may set its own env var of that name for
 *  subagent-scoped hook commands — which would silently clobber ours and
 *  misroute events. Prefixing makes the collision impossible regardless of
 *  whether that CLI behavior is ever confirmed. Safe to rename outright with
 *  no dual-read compat shim: the shim script that reads this is rewritten
 *  unconditionally by `ensureFiles()` on every app start, before any pty can
 *  spawn (see `app.whenReady` in index.ts), so setter (pty.ts, via this
 *  constant) and reader (the regenerated shim) can never disagree. */
export const AGENT_ID_ENV = 'POKEHARNESS_AGENT_ID';

/** External-codex-delegate feature — env vars an orchestrator sets on its own
 *  `codex exec` launch (never on a harness-spawned pty, which knows nothing
 *  about delegates). Codex spawns each hook invocation as a child process of
 *  that `codex exec`, so these inherit into the shim's env exactly the same
 *  way AGENT_ID_ENV does for a real harness session — read at hook-run time,
 *  below. `DELEGATE_PARENT_ENV` names the harness session id the delegate
 *  battler attaches to; `DELEGATE_LABEL_ENV` is an optional card title. */
export const DELEGATE_PARENT_ENV = 'POKEHARNESS_DELEGATE_PARENT';
export const DELEGATE_LABEL_ENV = 'POKEHARNESS_DELEGATE_LABEL';

const SHIM_FILENAME = 'cth-hook.cjs';
/** Codex-flavored sibling shim's filename (see `CODEX_HOOK_SHIM` below) —
 *  also the substring codexHooks.ts matches on to recognize "this is our own
 *  hooks.json entry, from THIS install" regardless of the exact absolute
 *  launcher/shim path (which embeds `userData` and so differs between a dev
 *  and a packaged build). */
export const CODEX_SHIM_FILENAME = 'cth-hook-codex.cjs';

/** The generated shim script. Deliberately dumb: read stdin, add
 *  harness_agent_id from env, forward to the socket, print whatever comes
 *  back (Claude expects hook stdout to be either empty or a JSON
 *  hookSpecificOutput blob), exit. Never blocks longer than a few seconds
 *  even if the app is gone.
 *
 *  Stamped field is `harness_agent_id`, NOT `agent_id`: confirmed via a live
 *  claude session that Claude Code's own hook payloads for a subagent's
 *  (Task tool) tool calls and its SubagentStop already carry a top-level
 *  `agent_id` (+ `agent_type`) identifying the CLI's *internal* subagent —
 *  unrelated to this app's session id. Stamping into `agent_id` collided
 *  with that and misrouted every subagent-scoped event to a channel the
 *  renderer never subscribes to (see HookBridge.handle below). Always
 *  overwritten, never guarded — this field name is ours alone.
 *
 *  Also stamps `harness_delegate_parent`/`harness_delegate_label` from
 *  DELEGATE_PARENT_ENV/DELEGATE_LABEL_ENV, read at hook-run time exactly
 *  like `harness_agent_id` above — null on every ordinary harness session
 *  (those two vars are never set on a harness-spawned pty), present only
 *  when this exact hook invocation's own env carries them (an external
 *  `codex exec` delegate run — see HookBridge.handleDelegate). */
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  payload.harness_agent_id = process.env.${AGENT_ID_ENV} || null;
  payload.harness_delegate_parent = process.env.${DELEGATE_PARENT_ENV} || null;
  payload.harness_delegate_label = process.env.${DELEGATE_LABEL_ENV} || null;
  const sock = process.env.${HOOK_SOCK_ENV};
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

/** Codex-flavored sibling shim (main/codexHooks.ts's `ensureCodexHooks` wires
 *  this into codex's own `$CODEX_HOME/hooks.json`, not any Claude settings
 *  file) — a translator, not a copy of HOOK_SHIM above, for one
 *  deliberate reason: it NEVER stamps `harness_agent_id`.
 *
 *  A delegate `codex exec` is launched from inside a harness `claude` pty
 *  (the "orchestrator" — see DELEGATE_PARENT_ENV's own doc comment), which
 *  means it inherits that pty's ENTIRE environment as its own process env,
 *  including that pty's own `POKEHARNESS_AGENT_ID` — confirmed against
 *  codex's source (openai/codex @ 0.150.1, codex-rs/hooks/src/registry.rs:
 *  `Hooks::new` snapshots `std::env::vars_os()` once at codex startup, and
 *  codex-rs/protocol/src/shell_environment.rs's `scrub_non_inheritable_env_
 *  vars` only strips a short fixed list of codex-internal auth/identity
 *  vars — nothing of ours — so a hook subprocess DOES see whatever env the
 *  `codex exec` process itself launched with, unfiltered by codex's separate
 *  `shell_environment_policy`, which only governs the model's own shell-tool
 *  calls). If this shim stamped `harness_agent_id` the same way HOOK_SHIM
 *  does, every codex delegate event would carry the ORCHESTRATOR's own
 *  agentId, and HookBridge.handle's `if (!agentId)` branch would route it
 *  onto the orchestrator's own `hooks:event:<agentId>` channel instead of
 *  `handleDelegate` below — corrupting the parent's own status/battle state
 *  with a codex session's events, exactly what `handleDelegate`'s routing
 *  exists to prevent. Leaving `harness_agent_id` unset (undefined, not even
 *  null) is what makes `HookBridge.handle`'s early check treat every codex
 *  payload as delegate-or-unrelated, never as a harness session's own event.
 *
 *  Field names on the payload this reads (`hook_event_name`, `session_id`)
 *  need no translation — confirmed identical to Claude's via codex's own
 *  generated JSON schemas (codex-rs/hooks/schema/generated/session-start.
 *  command.input.schema.json, stop.command.input.schema.json: both list
 *  `hook_event_name` and `session_id` as required string fields) — so this
 *  shim only needs to ADD the two delegate fields, never rename anything. */
const CODEX_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  payload.harness_delegate_parent = process.env.${DELEGATE_PARENT_ENV} || null;
  payload.harness_delegate_label = process.env.${DELEGATE_LABEL_ENV} || null;
  const sock = process.env.${HOOK_SOCK_ENV};
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

export class HookBridge {
  private server: Server | null = null;
  private readonly binDir: string;
  private readonly shimFile: string;
  private readonly codexShimFile: string;
  private readonly launcherFile: string;
  readonly sockPath: string;
  /** BACKLOG "next up" item 2 — mirrors index.ts's `keepAwakeEnabled` module
   *  variable pattern for a setting read at spawn time rather than passed
   *  through per-call. Default off so a freshly-constructed bridge (tests,
   *  other callers) behaves exactly as before this setting existed. */
  private hideStatusline = false;

  constructor(
    userDataDir: string,
    private getWebContents: () => WebContents | null,
    /** Phase 8.5 Wave B item 1 — fired with every payload that has a known
     *  agentId, regardless of event type or whether it's forwarded to the
     *  renderer, so the cost/context HUD's transcript-path registration
     *  (idempotent — see costWatcher.ts) isn't tied to any one hook event.
     *  Optional so this class stays usable standalone (tests, other
     *  callers) without a cost watcher in the loop. */
    private onRawPayload?: (agentId: string, transcriptPath: string | undefined) => void,
    /** External-codex-delegate feature — validates a delegate's
     *  `POKEHARNESS_DELEGATE_PARENT` actually names a live harness session
     *  before `handleDelegate` forwards anything to the renderer, so a
     *  stale/typo'd parent id can't spawn an orphaned battler. Optional so
     *  this class stays usable standalone (tests, other callers) without a
     *  live PtyManager in the loop, same reasoning as `onRawPayload` above. */
    private isKnownSession?: (id: string) => boolean
  ) {
    this.binDir = join(userDataDir, 'hooks-bin');
    this.shimFile = join(this.binDir, SHIM_FILENAME);
    this.codexShimFile = join(this.binDir, CODEX_SHIM_FILENAME);
    this.launcherFile = join(this.binDir, process.platform === 'win32' ? 'poke-node.cmd' : 'poke-node');
    this.sockPath = join(userDataDir, 'hooks.sock');
  }

  /** Write the shim(s) + bundled-node launcher. Idempotent, refreshed every
   *  call so a code change always takes effect on the next app start. Writes
   *  the codex-flavored shim unconditionally, same as the claude one — it's
   *  an inert file on disk until codexHooks.ts's `ensureCodexHooks` actually
   *  wires it into codex's hooks.json (itself gated on `codexDelegateHooks`
   *  and codex being installed), so writing it here has no behavior cost. */
  ensureFiles(): void {
    mkdirSync(this.binDir, { recursive: true });
    writeFileSync(this.shimFile, HOOK_SHIM, 'utf8');
    writeFileSync(this.codexShimFile, CODEX_HOOK_SHIM, 'utf8');
    try {
      if (process.platform === 'win32') {
        writeFileSync(
          this.launcherFile,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        writeFileSync(
          this.launcherFile,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`,
          'utf8'
        );
        chmodSync(this.launcherFile, 0o755);
      }
    } catch (e) {
      console.error('[hooks] writing node launcher failed:', e);
    }
  }

  /** Start listening on the UDS. Independent of any live claude session — the
   *  server must be up before the first spawn ever happens, and a fake-payload
   *  shim run (verification) must be able to reach it with no session live. */
  start(): void {
    if (this.server) return;
    try {
      if (existsSync(this.sockPath)) rmSync(this.sockPath);
    } catch {
      /* best-effort — a stale socket file from a crashed prior run */
    }
    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        let payload: HookPayload = {};
        try {
          payload = JSON.parse(buf.slice(0, nl));
        } catch (e) {
          // Malformed line — respond empty rather than hang the shim.
          // Capped: this is the one place raw, agent-controlled content
          // enters the diagnostics log, and it can carry user prompt/file
          // text — log a short breadcrumb (parse error, length, a 120-char
          // prefix) rather than the raw payload.
          const raw = buf.slice(0, nl);
          log('hooks', 'warn', 'malformed hook payload — dropped', {
            error: e instanceof Error ? e.message : String(e),
            length: raw.length,
            prefix: raw.slice(0, 120)
          });
        }
        let res: unknown = {};
        try {
          res = this.handle(payload);
        } catch (e) {
          console.error('[hooks] handler threw:', e);
          res = {};
        }
        // Always write a response and end the connection — the shim blocks on
        // this until its own 5s timeout, and every subsequent tool call in
        // that session would stall by that long if we ever forgot to reply.
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => {
        /* shim hung up early — ignore */
      });
    });
    this.server.on('error', (e: NodeJS.ErrnoException) => {
      // EADDRINUSE here means a second app instance is running (both bind
      // the same per-userData sockPath) — harmless: the first instance's
      // socket keeps serving hooks fine, the second just won't route any
      // (see BACKLOG's known-items note this closes).
      if (e.code === 'EADDRINUSE') {
        log('hooks', 'warn', 'hooks socket already in use — likely a second app instance; its hook events will be dropped', {
          sockPath: this.sockPath
        });
      } else {
        log('hooks', 'error', 'hooks socket server error', { message: e.message, code: e.code });
      }
    });
    this.server.listen(this.sockPath);
  }

  stop(): void {
    try {
      this.server?.close();
    } catch {
      /* noop */
    }
    this.server = null;
    try {
      if (existsSync(this.sockPath)) rmSync(this.sockPath);
    } catch {
      /* noop */
    }
  }

  /** Absolute, quoted `<launcher> <shim>` command for a settings hook entry.
   *  Quoted because userData may contain spaces and this string runs via
   *  `sh -c`. */
  private hookCommand(): string {
    return `"${this.launcherFile}" "${this.shimFile}"`;
  }

  /** Same shape as `hookCommand()` above but for the codex-flavored shim, and
   *  public: unlike the claude one (only ever used from `prepareSession`
   *  below), this is consumed from codexHooks.ts, outside this class — that
   *  file owns merging codex's own `hooks.json`, but reuses this class's
   *  already-solved bundled-node launcher (see HOOK_SHIM's own header for
   *  why a plain `node "<script>"` command isn't reliable here) rather than
   *  re-deriving it. */
  codexHookCommand(): string {
    return `"${this.launcherFile}" "${this.codexShimFile}"`;
  }

  /** Per-session Claude Code settings routing every wired hook through the
   *  shim. Written fresh on every spawn so a code change here always takes
   *  effect without a stale file lingering from a previous run. */
  prepareSession(agentId: string, tmpDir: string): string {
    mkdirSync(tmpDir, { recursive: true });
    const settingsPath = join(tmpDir, `hook-settings-${agentId}.json`);
    const cmd = this.hookCommand();
    const entry = (matcher?: string): { matcher?: string; hooks: { type: string; command: string }[] } => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    const settings = {
      hooks: {
        SessionStart: [entry()],
        UserPromptSubmit: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        Notification: [entry()],
        Stop: [entry()],
        // Wired, but not relied on: confirmed against real transcripts that
        // Claude Code's Agent/Task tool dispatches every subagent
        // asynchronously and delivers completion via an internal message
        // that never reaches ANY hook (not SubagentStop, not even
        // UserPromptSubmit for the injected notification) — see
        // hookRouter.ts's SubagentStop case and BattleManager.ts's file
        // header for the fallback this app actually uses.
        SubagentStop: [entry()],
        // Phase 8.5 Wave B item 4 — fires just before a compaction; the
        // post-compact SessionStart (source: 'compact') that follows is
        // already covered by the SessionStart entry above.
        PreCompact: [entry()]
      },
      // BACKLOG "next up" item 2 — only added when the user opts in
      // (settings → terminal → "hide claude statusline"); when off this key
      // is omitted entirely so the file is byte-identical to before this
      // feature existed and a session inherits `~/.claude/settings.json`'s
      // own `statusLine` exactly as today (CLI-flag settings win over user
      // settings, so an omitted key here is what "untouched" requires).
      // `command: ":"` — the POSIX shell no-op builtin — exits 0 and writes
      // nothing to stdout. Deliberately `:` and not `true`: Claude Code's
      // docs don't document the shell environment `statusLine.command` runs
      // under, and this app's own HOOK_SHIM above needed a PATH workaround
      // because Claude invokes ITS shell commands via a bare `sh -c` with a
      // stripped PATH — `true` is only guaranteed to resolve if `/usr/bin`
      // (or wherever it lives) is on that PATH, while `:` is a POSIX
      // "special builtin" every conforming shell must implement with no
      // external binary lookup, so it can't fail to resolve. Per Claude
      // Code's docs (Troubleshooting: "Scripts that exit with non-zero
      // codes or produce no output cause the status line to go blank"), a
      // no-output command leaves the row blank rather than erroring — this
      // is documented as the failure-mode behavior, not a formal "disable"
      // API, so it's correct by observation rather than by contract. The
      // row itself still reserves its line and the footer's keyboard-hint
      // text (`esc to interrupt`, `? for shortcuts`, `hold space to speak`)
      // still collapses the way it does for any configured `statusLine` —
      // that's a real, documented side effect of setting this key at all,
      // not something an empty command avoids.
      ...(this.hideStatusline ? { statusLine: { type: 'command', command: ':' } } : {})
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return settingsPath;
  }

  /** Set from `appSettings.hideClaudeStatusline` at boot and on every
   *  settings save (main/index.ts) — read by the next `prepareSession` call,
   *  so it only affects sessions spawned/respawned after the toggle changes
   *  (existing ptys keep whatever they launched with, per spec). */
  setHideStatusline(hide: boolean): void {
    this.hideStatusline = hide;
  }

  /** Best-effort teardown of a session's generated settings file. */
  cleanupSession(agentId: string, tmpDir: string): void {
    try {
      const p = join(tmpDir, `hook-settings-${agentId}.json`);
      if (existsSync(p)) rmSync(p);
    } catch {
      /* noop */
    }
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.harness_agent_id ?? undefined;
    const eventName = p.hook_event_name ?? 'Unknown';
    if (!agentId) {
      // No known harness session on this payload — either a genuinely
      // unrelated hook firing (dropped, as before this feature existed) or
      // an external-codex-delegate run (POKEHARNESS_AGENT_ID is never set
      // on those, by definition — see this file's header). Delegate
      // identity travels via the separate `harness_delegate_*` fields the
      // shim stamps above, so it's handled on its own path rather than
      // falling through the ordinary agentId-keyed logic below.
      this.handleDelegate(p, eventName);
      return {};
    }
    this.onRawPayload?.(agentId, p.transcript_path);
    if (!isKnownHookEvent(eventName)) return {};

    const tool = normalizeToolName(p.tool_name);
    const event: HookEvent = {
      agentId,
      event: eventName,
      tool,
      toolTarget: toolTargetFromInput(tool, p.tool_input),
      notificationType: p.notification_type,
      message: p.message,
      source: p.source,
      claudeSessionId: p.session_id,
      toolUseId: p.tool_use_id
    };
    const wc = this.getWebContents();
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send(`hooks:event:${agentId}`, event);
      } catch {
        /* window tore down mid-send */
      }
    }
    // Never gate/deny — this app's hooks are observation-only.
    return {};
  }

  /** External-codex-delegate feature — routes a delegate's SessionStart/Stop
   *  to the renderer on its own `hooks:delegate` channel, deliberately never
   *  `hooks:event:<agentId>`: that channel is the PARENT's own hook stream
   *  (hookRouter.ts's SessionStart/Stop cases reset its status/tool display
   *  and, for Stop, end its real battles), and a delegate landing there
   *  would corrupt it exactly the way BACKLOG's "subagent events on the
   *  parent's channel" watch item describes for Claude subagents. Also never
   *  calls `onRawPayload` — that registers a transcript path against the
   *  named agentId's cost/context HUD (costWatcher.ts), and a delegate has
   *  no agentId of its own to register under; using the PARENT's id would
   *  wrongly attribute the codex transcript to the parent's HUD. */
  private handleDelegate(p: HookPayload, eventName: string): void {
    const parentId = p.harness_delegate_parent ?? undefined;
    if (!parentId) return; // a genuinely unrelated hook firing — drop silently
    if (eventName !== 'SessionStart' && eventName !== 'Stop') {
      // Every other delegate event (PreToolUse, PostToolUse, Notification,
      // ...) is a logged no-op, never routed anywhere — item 3's guard.
      log('hooks', 'info', 'delegate hook event dropped (not SessionStart/Stop)', {
        parentId,
        event: eventName
      });
      return;
    }
    if (!this.isKnownSession?.(parentId)) {
      log('hooks', 'warn', 'delegate hook event — unknown/dead parent session, dropped', {
        parentId,
        event: eventName
      });
      return;
    }
    const label = p.harness_delegate_label?.trim() || 'codex delegate';
    // Codex's own hook payload field name for this IS `session_id`, same as
    // Claude's — confirmed against codex's generated JSON schemas (openai/
    // codex @ 0.150.1, codex-rs/hooks/schema/generated/session-start.command.
    // input.schema.json and stop.command.input.schema.json both require it),
    // resolving the "UNVERIFIED, assumed by analogy" caveat this comment used
    // to carry (see CODEX_HOOK_SHIM's own header in this file, and
    // codexHooks.ts, for the fuller citation). The parent+label fallback
    // below is kept as defensive code — `session_id` is a required field on
    // every codex hook payload per that schema, so in practice this branch
    // is provably unreachable against a spec-conforming codex build, but
    // costs nothing to keep for a payload this app hasn't itself captured
    // live (still true — see this file's constraints).
    const codexSessionId = p.session_id?.trim() || `delegate:${parentId}:${label}`;
    const signal: DelegateHookSignal = { parentId, event: eventName, codexSessionId, label };
    const wc = this.getWebContents();
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send('hooks:delegate', signal);
      } catch {
        /* window tore down mid-send */
      }
    }
  }
}
