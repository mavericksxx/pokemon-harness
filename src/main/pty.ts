/**
 * PtyManager — spawns coding-agent CLIs in a pseudo-terminal and streams their
 * output to the renderer over per-id IPC channels (`pty:data:<id>`,
 * `pty:exit:<id>`).
 *
 * Trimmed port of munder-difflin's `src/main/pty.ts` (MIT, Chaitanya Giri).
 * Kept: command resolution against the user's real shell PATH, the session
 * identity guard in onData/onExit, per-id channels, the safeSend teardown guard.
 * Dropped: everything Windows (conpty, npm .cmd shim decoding), hive env
 * injection, multi-window owner routing, worktrees, process-tree sweeping.
 */
import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { buildAgentsFlagValue } from './bundledHarnessAgents';
import { expandTilde, resolveCommand, userShellPath } from './shellEnv';
import { AGENT_ID_ENV, HOOK_SOCK_ENV, type HookBridge } from './hookBridge';
import { log } from './diagnostics';
import type { PtyExit, PtyInfo, PtyResult, SpawnPtyOptions } from '../shared/types';
import { TERMINAL_COLORS } from '../shared/terminalColors';
import { FRAME_DATA, FRAME_EXIT, FRAME_KILL, FRAME_WRITE, FrameDecoder, encodeFrame } from './ptyKeeperProtocol';

/** Where per-session hook settings.json files live — plain OS temp, not
 *  userData: these are throwaway routing files, not app state. */
function hookTmpDir(): string {
  return join(tmpdir(), 'pokemon-harness-hooks');
}

/** "Leave them running" quit path — where a detached session's keeper
 *  socket + sidecar metadata file live. Same "plain OS temp, throwaway"
 *  posture as `hookTmpDir` above, not userData. */
function keeperDir(): string {
  return join(tmpdir(), 'pokemon-harness-keepers');
}
function keeperSockPath(id: string): string {
  return join(keeperDir(), `${id}.sock`);
}
/** Session fields the keeper process itself has no use for (cwd, command,
 *  env, ...) but `tryReattach` needs to rebuild a real `PtySession` — see
 *  `detachToKeeper`/`tryReattach` and this file's own `KeeperMeta`. Single-
 *  use: written at detach time, read (and removed) on the one reattach
 *  attempt that follows. */
function keeperMetaPath(id: string): string {
  return join(keeperDir(), `${id}.json`);
}
/** `ptyKeeper.ts`'s own build output — a sibling of this bundle's own file
 *  (out/main/index.js next to out/main/ptyKeeper.js), same directory in
 *  BOTH `npm run dev` (electron-vite dev still actually builds main/preload
 *  to `out/`, only the renderer is dev-served) and a packaged build — same
 *  `__dirname`-relative pattern index.ts already uses for the preload
 *  script. Electron's asar support reads plain JS out of app.asar
 *  transparently for both `require()` and a script path handed to its own
 *  binary (ELECTRON_RUN_AS_NODE keeps that support — it only turns off the
 *  browser/renderer machinery, not asar), so this file does NOT need
 *  asarUnpack treatment the way node-pty's native binding does. */
function keeperScriptPath(): string {
  return join(__dirname, 'ptyKeeper.js');
}

/** Trailing output kept per session so a renderer crash's reload can repaint
 *  the visible terminal instead of showing it blank until new output arrives
 *  — see `getReplay` and index.ts's `sessions:restore`. Rough chars-as-bytes
 *  bound, not exact UTF-8 accounting: precision doesn't matter for a display
 *  backfill. */
const REPLAY_MAX_CHARS = 200_000;

/** Session-identity env vars the Claude Code CLI stamps onto its own child
 *  processes. If pokeharness's own env carries these (e.g. the app was
 *  launched from inside an existing Claude Code session), they'd otherwise
 *  leak into every spawned agent via the process.env spread in
 *  `buildBaseEnv`, making the CLI mistake a fresh top-level agent for a
 *  nested child/subagent session. Mirrors Claude Code's own denylist for
 *  spawning a clean top-level session from inside an existing one. */
const CLEAN_LAUNCH_ENV_DENYLIST = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHROME_MCP_ORG_DENIED',
  'CLAUDE_CODE_EVAL_INTERVIEW_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PID'
] as const;

/** Hard cap on concurrently live sessions (`this.sessions.size`) — a runaway
 *  loop or scripted spam of `spawn()` calls would otherwise exhaust OS
 *  file descriptors/PTYs with no limit at all. Comfortably above any real
 *  usage (garden + delegates) while still bounding worst case. */
const MAX_CONCURRENT_SESSIONS = 64;

/** Cap on `lastExitCodes` (a dead session's id is normally removed the one
 *  time `sessionRespawn.ts`'s boot restore consumes it via
 *  `takeLastExitCode` — see that map's own comment) — belt-and-braces
 *  against any id that's never consumed (a session that dies and is never
 *  part of a boot respawn) piling up for the life of the process. Evicted
 *  oldest-by-insertion-order, same shape as `MAX_CONCURRENT_SESSIONS`. */
const MAX_LAST_EXIT_CODES = 200;

/** How long a first-class delegate's natural-exit snapshot stays in
 *  `delegateExits` before an unclaimed entry expires — same set-then-
 *  auto-clear idea as index.ts's `pendingCrashInfo`/`PENDING_CRASH_INFO_TTL_MS`,
 *  but per-entry (a `setTimeout` tied to each insertion, cleared the moment
 *  it's claimed via `getDelegateExit`/`kill`) rather than one shared timer,
 *  since more than one delegate can exit before its parent ever asks. */
const DELEGATE_EXIT_TTL_MS = 10 * 60 * 1000;

/** The complete runtime surface this file actually uses off `.proc` (grepped
 *  — lines ~401/410/647/701/712/734/746/770/814 as of this writing: write,
 *  resize, kill, pid, onData, onExit, nothing else). A direct `pty.spawn()`
 *  result satisfies this structurally already, no change at normal spawn
 *  time — the point of narrowing it is that `KeeperClient` (a fake `.proc`
 *  backed by a reattached keeper socket, see `tryReattach`) can satisfy it
 *  too, without needing to fake the rest of `pty.IPty` (cols/rows/process/
 *  handleFlowControl/clear/pause/resume) it never implements. */
type PtyLike = Pick<pty.IPty, 'pid' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;

interface PtySession {
  id: string;
  proc: PtyLike;
  cwd: string;
  command: string;
  /** Epoch ms of the most recent byte this PTY emitted. */
  lastOutputAt: number;
  /** Last REPLAY_MAX_CHARS of this PTY's output. */
  replay: string;
  /** Full env this process was launched with — kept so a fallback shell (see
   *  `spawnFallbackShell`) can be spawned with the exact same env the CLI
   *  had, hook stamps (AGENT_ID_ENV/HOOK_SOCK_ENV) included. */
  env: Record<string, string>;
  /** True only for the shell `spawnFallbackShell` itself spawned — the
   *  fallback-on-exit check in `onExit` reads this so a fallback shell's own
   *  exit shows the plain dead state instead of chaining another fallback. */
  isFallback: boolean;
  /** First-class delegate sessions never become fallback shells. */
  isDelegate: boolean;
  provider?: string;
  claudeSettingsPath?: string;
  rendererAttached: boolean;
  oscCarry: string;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  /** Natural exits retained briefly for first-class delegates whose renderer
   *  adoption can arrive after a very fast `codex exec` has already ended.
   *  Each entry carries its own expiry timer (`DELEGATE_EXIT_TTL_MS`) so an
   *  adoption that never comes doesn't pin the entry here forever. */
  private delegateExits = new Map<string, { exit: PtyExit; timer: ReturnType<typeof setTimeout> }>();
  private webContents: WebContents | null = null;
  /** BUG/UX fix — whether a naturally-exited session's pty respawns the
   *  user's shell instead of leaving the tab dead. Set from
   *  `appSettings.shellFallbackEnabled` at boot and on every settings save
   *  (main/index.ts), mirroring HookBridge.setHideStatusline. Default true. */
  private shellFallbackEnabled = true;
  /** Harness-owned instructions file (HARNESS.md) — whether the setting is
   *  on, and its resolved `<harnessHomeDir>/HARNESS.md` path (null before
   *  harness home is resolved at boot). Set at boot, on every settings save,
   *  and whenever the harness home dir changes at runtime (main/index.ts),
   *  same pattern as `shellFallbackEnabled` above. Read synchronously inside
   *  `spawn()` itself (not cached) — the file's CURRENT on-disk contents are
   *  the live source (see harnessInstructions.ts), so an edit takes effect
   *  on the very next spawn, no settings save needed. */
  private harnessInstructionsEnabled = true;
  private harnessInstructionsPath: string | null = null;
  /** Which model/alias the bundled `advisor` subagent runs on — set from
   *  `appSettings.advisorModel` at boot and on every settings save (main/
   *  index.ts), same pattern as `harnessInstructionsEnabled` above. Read
   *  synchronously inside `spawn()` and passed through to
   *  `buildAgentsFlagValue` (bundledHarnessAgents.ts), which spreads it into
   *  the advisor agent definition's `model` key. Default `'fable'` mirrors
   *  `AppSettings.advisorModel`'s own default. */
  private advisorModel = 'fable';
  private terminalAppearance: 'light' | 'dark' = 'dark';
  private lastExitCodes = new Map<string, number>();

  /** Phase 4 Part A — optional so tests/other providers spawn unchanged when
   *  it's absent. `onSessionsChanged` (parity sweep item 4) fires after any
   *  change to the live-session count (spawn, kill, natural exit) — the
   *  keep-awake powerSaveBlocker's only signal for "is a session still
   *  live"; optional so callers that don't care about keep-awake are
   *  unaffected.
   *
   *  `onSessionExited` — GitHub #8 fix: fires with the specific `id` ONLY on
   *  the natural-exit branch of `spawn()`'s `onExit` (the child process died
   *  on its own), never from `kill()`/`killAll()`'s deliberate teardown —
   *  those already remove the session from `this.sessions` before the child
   *  dies, which trips the identity guard at the top of `onExit` and skips
   *  its whole body, this callback included. index.ts uses it to mirror
   *  `pty:kill`'s own `taskNotificationWatcher.unregisterSession(id)` call
   *  for the one exit path that handler never sees. Separate from
   *  `onSessionsChanged` (a plain "something changed" ping) because this one
   *  needs to carry WHICH id died. */
  constructor(
    private hookBridge?: HookBridge,
    private onSessionsChanged?: () => void,
    private onSessionExited?: (id: string) => void
  ) {}

  attachWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  /** Send to the renderer only if it's still alive. During quit, killing a PTY
   *  fires onExit asynchronously — by then the window may be destroyed, and
   *  `.send()` on a destroyed webContents throws. */
  private safeSend(channel: string, payload: unknown): void {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(channel, payload);
    } catch {
      /* window tore down mid-send */
    }
  }

  /** Whether a CLI is actually installed/locatable, using the exact same
   *  resolution spawn() uses so detection and spawning never disagree. */
  isCommandAvailable(command: string): boolean {
    return resolveCommand(command).found;
  }

  /** Set from `appSettings.shellFallbackEnabled` at boot and on every
   *  settings save (main/index.ts) — read the next time any session's pty
   *  exits naturally, so flipping it off never kills a fallback shell
   *  already running. */
  setShellFallbackEnabled(enabled: boolean): void {
    this.shellFallbackEnabled = enabled;
  }

  /** Set from `appSettings.harnessInstructionsEnabled` + the resolved
   *  HARNESS.md path at boot, on every settings save, and whenever the
   *  harness home dir changes at runtime (main/index.ts) — see this class's
   *  own field comment for why the path (not the file's contents) is what's
   *  cached here. */
  setHarnessInstructions(enabled: boolean, path: string | null): void {
    this.harnessInstructionsEnabled = enabled;
    this.harnessInstructionsPath = path;
  }

  /** Set from `appSettings.advisorModel` at boot and on every settings save
   *  (main/index.ts) — read the next time any claude session spawns, so
   *  changing it never touches an already-running session's pty. */
  setAdvisorModel(model: string): void {
    this.advisorModel = model;
  }

  /** Main owns this because boot respawns happen before the renderer exists;
   *  already-running CLIs do not re-read env when the theme toggles. */
  setTerminalAppearance(appearance: 'light' | 'dark'): void {
    this.terminalAppearance = appearance;
  }

  spawn(opts: SpawnPtyOptions, rendererAttached = false): PtyResult {
    // Socket inode self-heal (hooks.sock clobber bug) — on-demand check
    // right before every spawn (session or delegate — both funnel through
    // here), so a session that's about to need working hooks gets a
    // freshly-verified socket instead of possibly waiting on the periodic
    // timer (hookBridge.ts's `checkSocketHealth`).
    this.hookBridge?.checkSocketHealth();
    const cwd = expandTilde(opts.cwd);
    if (!existsSync(cwd)) {
      // Surfaced to the user in NewSessionDialog's own error text, but that's
      // UI-only — until now a spawn failure never reached harness.log, so a
      // "it wouldn't start" bug report had nothing to trace (BACKLOG
      // friend-testing readiness).
      log('pty', 'error', 'spawn failed: cwd does not exist', { id: opts.id, cwd });
      return { ok: false, error: `cwd does not exist: ${cwd}` };
    }

    // A respawn reusing a live id would orphan the old child. Kill it first.
    if (this.sessions.has(opts.id)) this.kill(opts.id);
    this.clearDelegateExit(opts.id);
    this.lastExitCodes.delete(opts.id);

    // Cap checked AFTER the reused-id kill above, so a respawn under an
    // existing id (net-zero session count) never gets rejected by its own
    // prior occupant. Fails clearly rather than letting an unbounded number
    // of node-pty children pile up.
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      log('pty', 'error', 'spawn failed: max concurrent sessions reached', {
        id: opts.id,
        max: MAX_CONCURRENT_SESSIONS
      });
      return { ok: false, error: `too many concurrent sessions (max ${MAX_CONCURRENT_SESSIONS})` };
    }

    const { path: file, found } = resolveCommand(opts.command);
    if (!found) {
      log('pty', 'error', 'spawn failed: command not found on PATH', { id: opts.id, command: opts.command });
      return { ok: false, error: `command not found on PATH: ${opts.command}` };
    }

    // Phase 4 Part A — wire the Claude Code hooks shim for claude sessions
    // only: a per-session --settings file routes lifecycle hooks over a UDS
    // back to this app, so the garden can use them as the authoritative state
    // source instead of scraping terminal text. Other providers are unaffected.
    let args = opts.args ?? [];
    let hookEnv: Record<string, string> = {};
    let claudeSettingsPath: string | undefined;
    if (opts.provider === 'claude' && this.hookBridge) {
      const settingsPath = this.hookBridge.prepareSession(opts.id, hookTmpDir());
      claudeSettingsPath = settingsPath;
      args = [...args, '--settings', settingsPath];
      hookEnv = { [AGENT_ID_ENV]: opts.id, [HOOK_SOCK_ENV]: this.hookBridge.sockPath };
    }

    // Harness-owned instructions file (HARNESS.md) — the harness's own
    // CLAUDE.md, appended into every TOP-LEVEL claude/codex session's argv.
    // Deliberately excludes poke-delegate spawns (`opts.isDelegate` — see
    // hookBridge.ts's `handleDelegateSpawn` and main/index.ts's
    // `onDelegateSpawnRequest`): those are subagents given their own task
    // prompt, not sessions that need the orchestrator's own operating
    // instructions. Read synchronously, right here, rather than cached at
    // `setHarnessInstructions` time — the file's CURRENT on-disk contents
    // are the live source (harnessInstructions.ts's header), so an edit
    // takes effect on the very next spawn. Missing/empty/unreadable file
    // just means no flag gets appended — same best-effort posture as every
    // other disk read in this function.
    if (!opts.isDelegate && this.harnessInstructionsEnabled && this.harnessInstructionsPath) {
      let instructions = '';
      try {
        instructions = readFileSync(this.harnessInstructionsPath, 'utf8');
      } catch {
        /* file missing/unreadable — spawn without it */
      }
      if (instructions.trim()) {
        if (opts.provider === 'claude') {
          // `claude --help`: --append-system-prompt-file <path> — appends to
          // (never replaces) Claude Code's own system prompt.
          args = [...args, '--append-system-prompt-file', this.harnessInstructionsPath];
        } else if (opts.provider === 'codex') {
          // Codex config docs (developers.openai.com/codex/config-reference)
          // describe `developer_instructions` as "Additional developer
          // instructions injected into the session (optional)" — additive,
          // unlike `model_instructions_file` (the renamed
          // `experimental_instructions_file`), which the SAME docs describe
          // as a "Replacement for built-in instructions instead of
          // AGENTS.md" — so that one is deliberately not used here. Passed
          // as a `-c key=value` override (`codex --help`'s `-c, --config
          // <key=value>`, "value ... parsed as TOML"); JSON.stringify
          // produces a TOML-compatible double-quoted string literal (same
          // \n/\"/\\ escaping) for ordinary text.
          args = [...args, '-c', `developer_instructions=${JSON.stringify(instructions)}`];
        }
      }
    }

    // Bundled `advisor` subagent — makes the hovering-companion feature
    // (renderer hookRouter.ts's detection of a Task dispatch with
    // `subagentType === 'advisor'`) work out of the box on a fresh install,
    // with zero personal config. Piggybacks on the SAME on/off toggle and
    // isDelegate exclusion as the HARNESS.md block above (this is
    // conceptually part of the same "harness instructions" feature, and a
    // delegate is a subagent given its own task, not an orchestrator session
    // that would ever dispatch a Task itself) — deliberately does NOT also
    // require `this.harnessInstructionsPath`, since the bundled agent has
    // nothing to do with the HARNESS.md file's on-disk contents.
    // `claude --help`: `--agents <json>  JSON object defining custom agents`.
    // See bundledHarnessAgents.ts for the value itself and why it's skipped
    // whenever the user already has their own `advisor.md`: `--agents` takes
    // precedence over an on-disk agent file, so injecting unconditionally
    // here would silently shadow a power user's own hand-written advisor
    // with this bundled one.
    if (!opts.isDelegate && this.harnessInstructionsEnabled && opts.provider === 'claude') {
      let agentsFlagValue: string | undefined;
      try {
        agentsFlagValue = buildAgentsFlagValue(cwd, this.advisorModel);
      } catch {
        /* best-effort — spawn without the bundled agent */
      }
      if (agentsFlagValue) {
        args = [...args, '--agents', agentsFlagValue];
      }
    }

    // `POKEHARNESS_DELEGATE_CMD` — exposes `poke-delegate` (the Codex lane
    // HARNESS.md instructs the orchestrator to spawn) to the orchestrating
    // session's own env, so it's actually invocable on a fresh install
    // instead of only existing as prose. Value is `hookBridge.ts`'s
    // `delegateCliCommand()`: a PRE-QUOTED shell command fragment
    // (`"<launcherPath>" "<delegateCliFile>"`) — quoted because
    // `launcherPath` can contain spaces (e.g. under `~/Library/Application
    // Support/...`). Those embedded `"` characters only get quote-removed by
    // bash when they appear in literal source, NOT when they arrive via
    // parameter expansion — so a caller must run it through `eval`. But
    // `eval` must be scoped to ONLY this pre-quoted fragment, never wrapped
    // around the whole command line: `eval "$POKEHARNESS_DELEGATE_CMD --cwd
    // ... --label ... '<prompt>'"` puts the (attacker/task-controlled)
    // prompt text inside the SAME outer double-quoted string, so bash
    // resolves backticks/`$(...)`/`$VAR` in the prompt as command
    // substitution/expansion before `eval` even runs — e.g. a prompt
    // containing `` `rm -rf /` `` executes it. Correct form: `eval "set --
    // $POKEHARNESS_DELEGATE_CMD"; "$@" --cwd ... --label ... '<prompt>'` —
    // `eval` re-parses only the pre-quoted launcher/file pair into positional
    // params, and the prompt (ordinary single-quoted text outside the eval'd
    // string) is never double-parsed. Same gating as the `--agents` block
    // above, plus `this.hookBridge` presence since the command comes from it.
    if (!opts.isDelegate && this.harnessInstructionsEnabled && opts.provider === 'claude' && this.hookBridge) {
      hookEnv.POKEHARNESS_DELEGATE_CMD = this.hookBridge.delegateCliCommand();
    }

    const env: Record<string, string> = {
      ...this.buildBaseEnv(opts.env),
      ...hookEnv
    };
    if (opts.env?.COLORFGBG === undefined) {
      env.COLORFGBG = this.terminalAppearance === 'light' ? '0;15' : '15;0';
    }
    if (!env.TERM_PROGRAM) env.TERM_PROGRAM = 'pokeharness';

    try {
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        cwd,
        env
      });

      // Capture THIS session so the proc's callbacks can tell whether the id
      // still belongs to them: a kill()+spawn() reusing the same id would
      // otherwise let the dying process spray bytes into the new session's
      // screen and delete it on exit.
      const session: PtySession = {
        id: opts.id,
        proc,
        cwd,
        command: file,
        lastOutputAt: Date.now(),
        replay: '',
        env,
        isFallback: false,
        provider: opts.provider,
        claudeSettingsPath,
        isDelegate: opts.isDelegate === true,
        rendererAttached,
        oscCarry: ''
      };
      this.sessions.set(opts.id, session);
      this.onSessionsChanged?.();
      this.wireSessionHandlers(opts.id, session);

      return { ok: true, cwd };
    } catch (e) {
      log('pty', 'error', 'spawn threw', {
        id: opts.id,
        command: opts.command,
        message: e instanceof Error ? e.message : String(e)
      });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Registers the onData/onExit handlers a live session's `proc` needs —
   *  factored out of `spawn()` so `tryReattach()` can wire up EXACTLY the
   *  same natural-exit handling (shell fallback, delegate-exit retention,
   *  GitHub #8 unregister, replay accumulation) for a `KeeperClient` adapter
   *  as a real freshly-spawned `pty.IPty` gets — a session detached then
   *  reattached must behave identically to one that was live the whole
   *  time once its underlying process eventually exits. `session.proc` is
   *  already set by the caller; this only wires callbacks onto it. */
  private wireSessionHandlers(id: string, session: PtySession): void {
    session.proc.onData((data) => {
      if (this.sessions.get(id) !== session) return;
      session.lastOutputAt = Date.now();
      const visible = this.handleDetachedQueries(session, data);
      if (!visible) return;
      session.replay = (session.replay + visible).slice(-REPLAY_MAX_CHARS);
      this.safeSend(`pty:data:${id}`, visible);
    });

    session.proc.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(id) !== session) return;
      if (exitCode !== 0) {
        log('pty', 'warn', 'session exited nonzero', { id, command: session.command, exitCode, signal });
      }
      this.setLastExitCode(id, exitCode);
      this.sessions.delete(id);
      this.onSessionsChanged?.();
      // GitHub #8 — unconditionally, even when a fallback shell is about to
      // take over this same id below: taskNotificationWatcher only ever
      // (re-)tracks an id via a CLI hook payload (registerSession), and a
      // plain shell process never fires hooks, so there's nothing here for
      // an unregister to wrongly cut off. Waiting on `willFallback` would
      // just leave the watcher's 2s poll spinning for a session that's no
      // longer an agentic CLI.
      this.onSessionExited?.(id);
      if (session.isDelegate) {
        const timer = setTimeout(() => this.delegateExits.delete(id), DELEGATE_EXIT_TTL_MS);
        this.delegateExits.set(id, { exit: { exitCode, signal, lastOutput: session.replay.slice(-16_000) }, timer });
      }

      // BUG/UX fix — a real terminal drops you to a shell when the
      // foreground process exits; this app used to just leave the tab
      // dead. Respawn the user's shell under the SAME id so it stays a
      // live, usable terminal. Skipped for: a fallback shell's OWN exit
      // (`session.isFallback` — no chained respawn loop), a delegate
      // (`session.isDelegate` must stay dead), and the opt-out setting.
      // Arceus is DELIBERATELY no longer excluded here (BACKLOG item 3 —
      // "when his CLI exits, the terminal is dead") — he now gets the
      // exact same drop-to-shell behavior as any other session. His own
      // resume/re-summon flow (arceus.ts's `tryResumeArceus`/
      // `autoSummonArceus`) still owns re-summoning him, but only ever
      // runs from an explicit user action (his rail card, or once at boot)
      // — never from this pty's own exit — so a fallback
      // shell riding under his id has nothing auto-re-summoning out from
      // under it while the user types into it. A later re-summon still
      // replaces that shell cleanly: spawn()'s reused-id kill (below in
      // this same file) tears down whatever is currently running under an
      // id before starting the new process, shell fallback included.
      // Computed BEFORE the `pty:exit` send below (not after spawning) so
      // the renderer's `PtyExit.fallback` flag is set in the SAME message
      // as the exit notice — see that field's own comment on why: its
      // regex tool-call parser must stop reading this channel before the
      // fallback shell's first byte, not after.
      const willFallback = this.shellFallbackEnabled && !session.isFallback && !session.isDelegate;
      this.safeSend(`pty:exit:${id}`, { exitCode, signal, fallback: willFallback });

      if (willFallback) {
        this.spawnFallbackShell(id, session.cwd, session.env, session);
      }
    });
  }

  /** Spawns the user's interactive shell under `id`, in `cwd`, with `env` —
   *  called only from a natural (non-deliberate) pty exit, see `spawn()`'s
   *  onExit above. Deliberate teardown (kill()/spawn() reusing a live id,
   *  killAll() on quit) never reaches this: each of those removes the
   *  session from `this.sessions` BEFORE the child actually dies, so the
   *  identity guard at the top of the ORIGINAL process's onExit —
   *  `this.sessions.get(id) !== session` — already returns early and this
   *  is never called for them.
   *
   *  `env` is the exact env the previous process had, hook stamps included
   *  (AGENT_ID_ENV/HOOK_SOCK_ENV — see pty.ts's spawn()). The fallback
   *  PATH shims add retained settings/instructions wiring when the user
   *  hand-relaunches claude or codex in this shell. */
  spawnFallbackShellFromRespawn(id: string, cwd: string, provider?: string, claudeSettingsPath?: string): PtyResult {
    // The boot resume exit may already have installed the one fallback shell.
    if (this.sessions.has(id)) return { ok: true, cwd };
    const shellCommand = process.env.SHELL || '/bin/zsh';
    const { path: file, found } = resolveCommand(shellCommand);
    if (!found) return { ok: false, error: `shell not found on PATH: ${shellCommand}` };
    const settingsPath = claudeSettingsPath ?? join(hookTmpDir(), `hook-settings-${id}.json`);
    const env = this.buildFallbackEnv(this.buildBaseEnv(), provider, existsSync(settingsPath) ? settingsPath : undefined, id);
    return this.spawnFallbackShellProcess(id, cwd, file, env, {
      provider,
      claudeSettingsPath: existsSync(settingsPath) ? settingsPath : undefined,
      rendererAttached: false
    });
  }

  private buildBaseEnv(overrides?: Record<string, string>): Record<string, string> {
    // Finder/Dock launches need the login-shell PATH and terminal defaults.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: userShellPath(),
      TERM: 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8'
    };
    // Every agent this app spawns is a real top-level session, never a
    // subagent — but if the app itself was launched from inside an existing
    // Claude Code session, identity/session markers leak through the
    // process.env spread above (e.g. CLAUDE_CODE_CHILD_SESSION makes the CLI
    // wrongly treat the spawned agent as a child session and disables
    // transcript persistence for it). This mirrors Claude Code's own
    // clean-launch denylist for spawning a fresh top-level session from
    // inside an existing one — keep it in sync with that list, don't trim it
    // back down to a single var.
    for (const key of CLEAN_LAUNCH_ENV_DENYLIST) delete env[key];
    Object.assign(env, overrides ?? {});
    return env;
  }

  private buildFallbackEnv(env: Record<string, string>, provider?: string, claudeSettingsPath?: string, agentId?: string): Record<string, string> {
    const fallbackEnv: Record<string, string> = {
      ...env,
      COLORFGBG: this.terminalAppearance === 'light' ? '0;15' : '15;0'
    };
    if (!fallbackEnv.TERM_PROGRAM) fallbackEnv.TERM_PROGRAM = 'pokeharness';
    if (this.hookBridge && (provider === 'claude' || provider === 'codex')) {
      const shimDir = this.hookBridge.cliShimPath();
      fallbackEnv.PATH = `${shimDir}:${env.PATH || userShellPath()}`;
      fallbackEnv.POKEHARNESS_CLI_SHIM_DIR = shimDir;
      const real = resolveCommand(provider);
      if (real.found) fallbackEnv[`POKEHARNESS_REAL_${provider.toUpperCase()}`] = real.path;
      fallbackEnv.POKEHARNESS_NODE = this.hookBridge.nodeLauncherPath();
      fallbackEnv.POKEHARNESS_JSON_HELPER = this.hookBridge.cliJsonHelperPath();
      if (provider === 'claude') {
        if (agentId) fallbackEnv[AGENT_ID_ENV] = agentId;
        fallbackEnv[HOOK_SOCK_ENV] = fallbackEnv[HOOK_SOCK_ENV] || this.hookBridge.sockPath;
      }
      if (provider === 'claude' && claudeSettingsPath) fallbackEnv.POKEHARNESS_CLAUDE_SETTINGS = claudeSettingsPath;
      if (this.harnessInstructionsEnabled && this.harnessInstructionsPath && existsSync(this.harnessInstructionsPath)) {
        fallbackEnv.POKEHARNESS_INSTRUCTIONS = this.harnessInstructionsPath;
      }
    }
    return fallbackEnv;
  }

  private spawnFallbackShell(id: string, cwd: string, env: Record<string, string>, source: PtySession): void {
    const shellCommand = process.env.SHELL || '/bin/zsh';
    const { path: file, found } = resolveCommand(shellCommand);
    if (!found) {
      log('pty', 'warn', 'shell fallback: shell not found on PATH', { id, shell: shellCommand });
      return;
    }

    const prior = source;
    const fallbackEnv = this.buildFallbackEnv(env, prior.provider, prior.claudeSettingsPath);

    this.spawnFallbackShellProcess(id, cwd, file, fallbackEnv, prior);
  }

  private spawnFallbackShellProcess(id: string, cwd: string, file: string, fallbackEnv: Record<string, string>, source: Pick<PtySession, 'provider' | 'claudeSettingsPath' | 'rendererAttached'>): PtyResult {

    try {
      const proc = pty.spawn(file, [], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd,
        env: fallbackEnv
      });

      // Dim, terse note (matches the app's own exit-notice styling in
      // terminalRegistry.ts) between the exit notice already sent above and
      // this shell's own first prompt bytes, which haven't arrived yet.
      // Seeded into `replay` (not just sent live) so a renderer crash/reload
      // while the fallback shell is up still backfills this line, same as
      // any other byte on this channel — see `getReplay`.
      const notice = '\r\n\x1b[90mdropped to shell — relaunch claude or codex here to keep pokeharness wiring\x1b[0m\r\n';

      const session: PtySession = {
        id,
        proc,
        cwd,
        command: file,
        lastOutputAt: Date.now(),
        replay: notice,
        env: fallbackEnv,
        isFallback: true,
        provider: source.provider,
        claudeSettingsPath: source.claudeSettingsPath,
        isDelegate: false,
        rendererAttached: source.rendererAttached,
        oscCarry: ''
      };
      this.sessions.set(id, session);
      this.onSessionsChanged?.();

      this.safeSend(`pty:data:${id}`, notice);

      proc.onData((data) => {
        if (this.sessions.get(id) !== session) return;
        session.lastOutputAt = Date.now();
        const visible = this.handleDetachedQueries(session, data);
        if (!visible) return;
        session.replay = (session.replay + visible).slice(-REPLAY_MAX_CHARS);
        this.safeSend(`pty:data:${id}`, visible);
      });

      proc.onExit(({ exitCode, signal }) => {
        // Deliberate teardown (kill()/spawn() reuse) already removed this
        // session before the child died — same identity guard as spawn()'s
        // own onExit. No fallback-of-a-fallback: `session.isFallback` above
        // is what stops spawn()'s onExit from ever reaching here for THIS
        // shell's own exit — this handler is a dead end on purpose.
        if (this.sessions.get(id) !== session) return;
        this.sessions.delete(id);
        this.onSessionsChanged?.();
        this.safeSend(`pty:exit:${id}`, { exitCode, signal });
      });
      return { ok: true, cwd };
    } catch (e) {
      log('pty', 'warn', 'shell fallback: spawn threw', {
        id,
        message: e instanceof Error ? e.message : String(e)
      });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private handleDetachedQueries(session: PtySession, data: string): string {
    if (session.rendererAttached) return data;
    // Boot respawns have no xterm to answer OSC queries; consume them here so
    // replay does not make xterm answer a stale query after it attaches.
    let input = session.oscCarry + data;
    session.oscCarry = '';
    const query = /\x1b\](10|11);\?(\x07|\x1b\\)/g;
    let output = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = query.exec(input))) {
      output += input.slice(cursor, match.index);
      const color = TERMINAL_COLORS[this.terminalAppearance];
      const hex = color[match[1] === '10' ? 'foreground' : 'background'].match(/[0-9a-f]{2}/gi) as string[];
      const channel = hex.map((part) => part + part).join('/');
      try { session.proc.write(`\x1b]${match[1]};rgb:${channel}${match[2]}`); } catch { /* process is exiting */ }
      cursor = query.lastIndex;
    }
    output += input.slice(cursor);
    const queries = [
      '\x1b]10;?\x07',
      '\x1b]11;?\x07',
      '\x1b]10;?\x1b\\',
      '\x1b]11;?\x1b\\'
    ];
    const maxQueryLength = Math.max(...queries.map((query) => query.length));
    const maxCarry = Math.min(output.length, maxQueryLength - 1);
    for (let length = maxCarry; length > 0; length -= 1) {
      const suffix = output.slice(-length);
      if (queries.some((query) => query.startsWith(suffix))) {
        session.oscCarry = suffix;
        output = output.slice(0, -length);
        break;
      }
    }
    return output;
  }

  /** External-codex-delegate feature (HookBridge.handleDelegate) — whether a
   *  session id names a currently-live pty, so a delegate's
   *  `POKEHARNESS_DELEGATE_PARENT` can be validated before anything spawns
   *  for it. */
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Exit snapshot for a fast first-class delegate adoption. Ordinary
   *  sessions do not retain exit state because their renderer listener is
   *  established before their PTY is spawned. */
  getDelegateExit(id: string): PtyExit | null {
    const entry = this.delegateExits.get(id);
    if (!entry) return null;
    this.clearDelegateExit(id);
    return entry.exit;
  }

  /** Removes a `delegateExits` entry and its TTL timer together — a bare
   *  `Map.delete` would leave the timer to fire later against an
   *  already-gone (or, worse, id-reused) entry. */
  private clearDelegateExit(id: string): void {
    const entry = this.delegateExits.get(id);
    if (entry) clearTimeout(entry.timer);
    this.delegateExits.delete(id);
  }

  write(id: string, data: string): PtyResult {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  resize(id: string, cols: number, rows: number): PtyResult {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    try {
      s.proc.resize(Math.max(cols, 2), Math.max(rows, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  kill(id: string): PtyResult {
    const s = this.sessions.get(id);
    if (!s) {
      // A natural delegate exit already removed the live PTY; this is the
      // later recall bookkeeping call, so drop its retained exit snapshot too.
      this.clearDelegateExit(id);
      return { ok: false, error: `no pty: ${id}` };
    }
    // Delete BEFORE killing: onExit fires asynchronously and its identity guard
    // then correctly treats the dying process as stale.
    this.sessions.delete(id);
    this.clearDelegateExit(id);
    this.onSessionsChanged?.();
    this.hookBridge?.cleanupSession(id, hookTmpDir());
    try {
      s.proc.kill();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** "Leave them running" quit path (QuitDialog.tsx's 5th action) — hands
   *  session `id`'s live pty master off to a small detached `ptyKeeper.ts`
   *  helper process instead of killing it, so the underlying CLI survives
   *  this app quitting entirely (see ptyKeeper.ts's own header for the
   *  validated mechanism). Returns false — caller falls back to a normal
   *  kill for just this one session — if `.fd` isn't available: shouldn't
   *  happen on this POSIX-only build (a direct `pty.spawn()` result is a
   *  `UnixTerminal`, which always exposes it at runtime), but `.fd` is
   *  deliberately NOT part of `PtyLike`'s typed surface, so this is a
   *  defensive runtime check, not a type-level guarantee. */
  detachToKeeper(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.proc instanceof KeeperClient) {
      // Already reattached to an existing keeper (relaunched once already
      // after a previous "leave them running" quit, now quitting the same
      // way again) — that keeper is already independently alive holding
      // the fd; nothing to spawn, just let go of our own connection to it
      // rather than killing a session the user explicitly asked to keep.
      session.proc.disconnect();
      this.sessions.delete(id);
      this.clearDelegateExit(id);
      this.onSessionsChanged?.();
      return true;
    }
    const fd = (session.proc as unknown as { fd?: number }).fd;
    if (typeof fd !== 'number') return false;
    const pid = session.proc.pid;
    try {
      mkdirSync(keeperDir(), { recursive: true });
      // Stop OUR OWN reader before the keeper gets its own dup of the same
      // fd — both reading the same open-file-description would otherwise
      // race, splitting bytes between whichever side happens to read them
      // first instead of the keeper reliably getting all of them. Public
      // `IPty.pause()`/`.resume()` (node-pty's `Terminal` base class — both
      // are a plain `this._socket.pause()`/`.resume()`), not part of
      // `PtyLike`'s narrowed surface since nothing else in this file ever
      // needs it.
      (session.proc as unknown as { pause?: () => void }).pause?.();
      const meta: KeeperMeta = {
        pid,
        cwd: session.cwd,
        command: session.command,
        env: session.env,
        isFallback: session.isFallback,
        isDelegate: session.isDelegate,
        provider: session.provider,
        claudeSettingsPath: session.claudeSettingsPath
      };
      writeFileSync(keeperMetaPath(id), JSON.stringify(meta), 'utf8');
      const child = spawnProcess(process.execPath, [keeperScriptPath(), keeperSockPath(id), String(pid)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', fd],
        detached: true
      });
      child.unref();
    } catch (e) {
      log('pty', 'warn', 'detach to keeper failed, falling back to kill', {
        id,
        message: e instanceof Error ? e.message : String(e)
      });
      // Resume reading — the handoff failed, this session stays live under
      // THIS process; the caller kills it normally right after.
      (session.proc as unknown as { resume?: () => void }).resume?.();
      return false;
    }
    // Same bookkeeping kill() does, minus the actual signal — the child is
    // deliberately left alive, owned by the keeper now.
    this.sessions.delete(id);
    this.clearDelegateExit(id);
    this.onSessionsChanged?.();
    this.hookBridge?.cleanupSession(id, hookTmpDir());
    return true;
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: s.proc.pid,
      lastOutputAt: s.lastOutputAt
    }));
  }

  /** Resolves `true` if session `id` is still alive after `graceMs`, `false`
   *  if it exits before then (or doesn't exist at all). Used only by
   *  app-launch session restore (main/index.ts) to detect a `claude --resume`
   *  that fails fast — an expired/invalid session id starts the process fine
   *  (spawn() alone can't see the failure) but the CLI prints an error and
   *  exits almost immediately. Piggybacks a second `onExit` listener onto the
   *  same proc rather than touching spawn()'s own — node-pty's onX are plain
   *  multi-listener events, so this never interferes with the exit handling
   *  spawn() already wired (map cleanup, `pty:exit:<id>` send). */
  waitAlive(id: string, graceMs: number): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(this.sessions.get(id) === session);
      }, graceMs);
      session.proc.onExit(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /** This PTY's trailing output (bounded, see REPLAY_MAX_CHARS), for a
   *  reattaching terminal to repaint before live data resumes. Empty for an
   *  unknown/dead id — the caller just gets a blank terminal, same as today. */
  getReplay(id: string): string {
    const session = this.sessions.get(id);
    if (session) session.rendererAttached = true;
    return session?.replay ?? '';
  }

  /** Records `id`'s exit code (`spawn()`'s `onExit`), evicting the oldest
   *  entry first if this would push the map past `MAX_LAST_EXIT_CODES` — see
   *  that constant's own comment. */
  private setLastExitCode(id: string, exitCode: number): void {
    if (!this.lastExitCodes.has(id) && this.lastExitCodes.size >= MAX_LAST_EXIT_CODES) {
      const oldest = this.lastExitCodes.keys().next().value;
      if (oldest !== undefined) this.lastExitCodes.delete(oldest);
    }
    this.lastExitCodes.set(id, exitCode);
  }

  /** Reads and removes `id`'s last recorded exit code — consumed at most
   *  once, by `sessionRespawn.ts`'s boot restore (its one caller), so a
   *  claimed entry doesn't linger in the map until `MAX_LAST_EXIT_CODES`
   *  eviction eventually gets to it. */
  takeLastExitCode(id: string): number | undefined {
    const code = this.lastExitCodes.get(id);
    this.lastExitCodes.delete(id);
    return code;
  }

  /** Bulk-kill for app quit. Closing the pty HUPs the child's process group, so
   *  trees die with it on POSIX. */
  killAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }

  /** Bulk hand-off for "leave them running" quit — mirrors `killAll()`'s
   *  loop, but detaches each session to its own keeper instead of signaling
   *  it. Falls back to a normal kill for any one session `detachToKeeper`
   *  can't handle, so nothing is silently orphaned by this quit path.
   *  Snapshots the id list first since `detachToKeeper`/`kill` both mutate
   *  `this.sessions` as they go. */
  detachAllToKeepers(): void {
    for (const id of [...this.sessions.keys()]) {
      if (!this.detachToKeeper(id)) this.kill(id);
    }
  }

  /** "Leave them running" quit path's counterpart to a fresh `spawn()` —
   *  attempts to reconnect to session `id`'s keeper (see ptyKeeper.ts).
   *  Returns false, touching nothing else, on any connection failure:
   *  ENOENT/ECONNREFUSED means either this id was never detached, or its
   *  keeper already exited because the underlying CLI finished naturally
   *  while detached — `sessionRespawn.ts`'s caller falls through to today's
   *  unchanged spawn/resume path for both cases, which already handles them
   *  correctly (a `claude --resume` against an already-completed transcript
   *  works fine). */
  async tryReattach(id: string): Promise<boolean> {
    let socket: Socket;
    try {
      socket = await connectKeeperSocket(keeperSockPath(id));
    } catch {
      return false;
    }
    const metaPath = keeperMetaPath(id);
    let meta: KeeperMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as KeeperMeta;
    } catch {
      // Metadata is a nice-to-have, not required for the reattach itself —
      // a session that comes back with blank cwd/command/env is still a
      // live, usable terminal; only cosmetic/fallback-env fields degrade.
      meta = { pid: 0, cwd: '', command: '', env: {}, isFallback: false, isDelegate: false };
    }
    try {
      unlinkSync(metaPath);
    } catch {
      /* best-effort — single-use file, a leftover here is harmless */
    }

    const proc = new KeeperClient(socket, meta.pid);
    const session: PtySession = {
      id,
      proc,
      cwd: meta.cwd,
      command: meta.command,
      lastOutputAt: Date.now(),
      replay: '',
      env: meta.env,
      isFallback: meta.isFallback,
      isDelegate: meta.isDelegate,
      provider: meta.provider,
      claudeSettingsPath: meta.claudeSettingsPath,
      // Same starting state a boot-respawned session gets (see
      // `spawnFallbackShellFromRespawn`) — flips true the moment the
      // renderer's terminal actually calls `getReplay()`.
      rendererAttached: false,
      oscCarry: ''
    };
    this.sessions.set(id, session);
    this.onSessionsChanged?.();
    // Backlog arrives as an ordinary FRAME_DATA the socket sends right after
    // connecting (see ptyKeeper.ts) — `wireSessionHandlers`'s onData is
    // already listening by the time that fires (KeeperClient buffers
    // nothing before its listeners are attached; the frame decoder only
    // starts running once the 'data' listener below is registered, and
    // Node doesn't deliver a socket's buffered bytes until something reads
    // them), so it lands in `session.replay`/gets flushed to the renderer
    // exactly like any other byte on this channel — no separate handling
    // needed here.
    this.wireSessionHandlers(id, session);
    return true;
  }
}

/** Session fields the keeper process itself has no use for (see
 *  `keeperMetaPath`) but `tryReattach` needs to rebuild a real
 *  `PtySession` — written by `detachToKeeper`, read once (and removed) by
 *  the one `tryReattach` attempt that follows. */
interface KeeperMeta {
  pid: number;
  cwd: string;
  command: string;
  env: Record<string, string>;
  isFallback: boolean;
  isDelegate: boolean;
  provider?: string;
  claudeSettingsPath?: string;
}

/** Connects to a keeper's Unix socket, resolving once (and only once) —
 *  rejects on ENOENT (no keeper ever existed for this id)/ECONNREFUSED (a
 *  stale socket file whose keeper already exited) just like any other
 *  `net.connect` failure. Split out from `tryReattach` only because a
 *  Promise-wrapped one-shot connect is easier to read as its own function
 *  than inlined. */
function connectKeeperSocket(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    const onError = (e: Error): void => {
      socket.removeListener('connect', onConnect);
      reject(e);
    };
    const onConnect = (): void => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

/** `PtyLike` adapter backed by a live socket connection to a detached
 *  session's keeper (see ptyKeeper.ts) — stands in for a real `pty.IPty`
 *  once `tryReattach` reconnects, so the rest of this file (write/resize/
 *  kill, `wireSessionHandlers`'s onData/onExit wiring) never needs to know
 *  the difference. */
class KeeperClient {
  readonly pid: number;
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private exited = false;

  constructor(socket: Socket, pid: number) {
    this.socket = socket;
    this.pid = pid;
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.type === FRAME_DATA) {
          const text = frame.payload.toString('utf8');
          for (const cb of this.dataListeners) cb(text);
        } else if (frame.type === FRAME_EXIT) {
          this.handleExit(parseExitFrame(frame.payload));
        }
      }
    });
    // The keeper vanishing without ever sending FRAME_EXIT (hard-killed,
    // machine slept mid-write, whatever) still has to surface as an exit —
    // otherwise this session would look perpetually alive with a socket
    // that will never emit another byte.
    socket.on('close', () => this.handleExit({ exitCode: 0 }));
    // 'close' always follows 'error' on a socket — this listener exists
    // only so an unhandled 'error' event can't crash the process; the
    // actual exit handling happens in the 'close' listener above.
    socket.on('error', () => {
      /* handled via 'close' above */
    });
  }

  private handleExit(e: { exitCode: number; signal?: number }): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitListeners) cb(e);
  }

  write(data: string | Buffer): void {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.socket.write(encodeFrame(FRAME_WRITE, payload));
  }

  /** No-op — see ptyKeeper.ts's header: resizing an inherited fd from a
   *  standalone process needs node-pty's own internal native binding,
   *  which this V1 doesn't attempt to reach from the keeper (unverifiable
   *  in a packaged asar build without actually shipping one — an accepted
   *  V1 limitation per this feature's design doc). A reattached terminal
   *  just keeps whatever size the pty already had. */
  resize(_cols: number, _rows: number): void {
    /* intentional no-op, see comment above */
  }

  kill(_signal?: string): void {
    this.socket.write(encodeFrame(FRAME_KILL, Buffer.alloc(0)));
  }

  /** Closes just OUR connection to the keeper — used when re-detaching an
   *  already-reattached session (`detachToKeeper`'s `instanceof KeeperClient`
   *  branch): unlike `kill()`, this must NOT touch the real child, the
   *  keeper is already independently holding it alive. */
  disconnect(): void {
    this.socket.destroy();
  }

  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== cb);
      }
    };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== cb);
      }
    };
  }
}

function parseExitFrame(payload: Buffer): { exitCode: number; signal?: number } {
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as { exitCode?: unknown; signal?: unknown };
    return {
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
      signal: typeof parsed.signal === 'number' ? parsed.signal : undefined
    };
  } catch {
    return { exitCode: 0 };
  }
}
