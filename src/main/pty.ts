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
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandTilde, resolveCommand, userShellPath } from './shellEnv';
import { AGENT_ID_ENV, HOOK_SOCK_ENV, type HookBridge } from './hookBridge';
import { log } from './diagnostics';
import type { PtyExit, PtyInfo, PtyResult, SpawnPtyOptions } from '../shared/types';

/** Where per-session hook settings.json files live — plain OS temp, not
 *  userData: these are throwaway routing files, not app state. */
function hookTmpDir(): string {
  return join(tmpdir(), 'pokemon-harness-hooks');
}

/** Trailing output kept per session so a renderer crash's reload can repaint
 *  the visible terminal instead of showing it blank until new output arrives
 *  — see `getReplay` and index.ts's `sessions:restore`. Rough chars-as-bytes
 *  bound, not exact UTF-8 accounting: precision doesn't matter for a display
 *  backfill. */
const REPLAY_MAX_CHARS = 200_000;

interface PtySession {
  id: string;
  proc: pty.IPty;
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
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  /** Natural exits retained briefly for first-class delegates whose renderer
   *  adoption can arrive after a very fast `codex exec` has already ended. */
  private delegateExits = new Map<string, PtyExit>();
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
  private terminalAppearance: 'light' | 'dark' = 'dark';

  /** Phase 4 Part A — optional so tests/other providers spawn unchanged when
   *  it's absent. `onSessionsChanged` (parity sweep item 4) fires after any
   *  change to the live-session count (spawn, kill, natural exit) — the
   *  keep-awake powerSaveBlocker's only signal for "is a session still
   *  live"; optional so callers that don't care about keep-awake are
   *  unaffected. */
  constructor(
    private hookBridge?: HookBridge,
    private onSessionsChanged?: () => void
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

  /** Main owns this because boot respawns happen before the renderer exists;
   *  already-running CLIs do not re-read env when the theme toggles. */
  setTerminalAppearance(appearance: 'light' | 'dark'): void {
    this.terminalAppearance = appearance;
  }

  spawn(opts: SpawnPtyOptions): PtyResult {
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
    this.delegateExits.delete(opts.id);

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

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: userShellPath(),
      TERM: 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8',
      ...(opts.env ?? {}),
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
        isDelegate: opts.isDelegate === true
      };
      this.sessions.set(opts.id, session);
      this.onSessionsChanged?.();

      proc.onData((data) => {
        if (this.sessions.get(opts.id) !== session) return;
        session.lastOutputAt = Date.now();
        session.replay = (session.replay + data).slice(-REPLAY_MAX_CHARS);
        this.safeSend(`pty:data:${opts.id}`, data);
      });

      proc.onExit(({ exitCode, signal }) => {
        if (this.sessions.get(opts.id) !== session) return;
        if (exitCode !== 0) {
          log('pty', 'warn', 'session exited nonzero', { id: opts.id, command: session.command, exitCode, signal });
        }
        this.sessions.delete(opts.id);
        this.onSessionsChanged?.();
        if (session.isDelegate) this.delegateExits.set(opts.id, { exitCode, signal });

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
        // runs from an explicit user action (his topbar chip/roster card, or
        // once at boot) — never from this pty's own exit — so a fallback
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
        this.safeSend(`pty:exit:${opts.id}`, { exitCode, signal, fallback: willFallback });

        if (willFallback) {
          this.spawnFallbackShell(opts.id, session.cwd, session.env, session);
        }
      });

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
  private spawnFallbackShell(id: string, cwd: string, env: Record<string, string>, source: PtySession): void {
    const shellCommand = process.env.SHELL || '/bin/zsh';
    const { path: file, found } = resolveCommand(shellCommand);
    if (!found) {
      log('pty', 'warn', 'shell fallback: shell not found on PATH', { id, shell: shellCommand });
      return;
    }

    const prior = source;
    const fallbackEnv = { ...env };
    fallbackEnv.COLORFGBG = this.terminalAppearance === 'light' ? '0;15' : '15;0';
    if (!fallbackEnv.TERM_PROGRAM) fallbackEnv.TERM_PROGRAM = 'pokeharness';
    if (this.hookBridge && prior?.provider && (prior.provider === 'claude' || prior.provider === 'codex')) {
      const shimDir = this.hookBridge.cliShimPath();
      fallbackEnv.PATH = `${shimDir}:${env.PATH || userShellPath()}`;
      fallbackEnv.POKEHARNESS_CLI_SHIM_DIR = shimDir;
      const real = resolveCommand(prior.provider);
      if (real.found) fallbackEnv[`POKEHARNESS_REAL_${prior.provider.toUpperCase()}`] = real.path;
      fallbackEnv.POKEHARNESS_NODE = this.hookBridge.nodeLauncherPath();
      fallbackEnv.POKEHARNESS_JSON_HELPER = this.hookBridge.cliJsonHelperPath();
      if (prior.provider === 'claude' && prior.claudeSettingsPath) {
        fallbackEnv.POKEHARNESS_CLAUDE_SETTINGS = prior.claudeSettingsPath;
      }
      if (this.harnessInstructionsEnabled && this.harnessInstructionsPath && existsSync(this.harnessInstructionsPath)) {
        fallbackEnv.POKEHARNESS_INSTRUCTIONS = this.harnessInstructionsPath;
      }
    }

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
        provider: prior?.provider,
        claudeSettingsPath: prior?.claudeSettingsPath,
        isDelegate: false
      };
      this.sessions.set(id, session);
      this.onSessionsChanged?.();

      this.safeSend(`pty:data:${id}`, notice);

      proc.onData((data) => {
        if (this.sessions.get(id) !== session) return;
        session.lastOutputAt = Date.now();
        session.replay = (session.replay + data).slice(-REPLAY_MAX_CHARS);
        this.safeSend(`pty:data:${id}`, data);
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
    } catch (e) {
      log('pty', 'warn', 'shell fallback: spawn threw', {
        id,
        message: e instanceof Error ? e.message : String(e)
      });
    }
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
    const exit = this.delegateExits.get(id) ?? null;
    if (exit) this.delegateExits.delete(id);
    return exit;
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
      this.delegateExits.delete(id);
      return { ok: false, error: `no pty: ${id}` };
    }
    // Delete BEFORE killing: onExit fires asynchronously and its identity guard
    // then correctly treats the dying process as stale.
    this.sessions.delete(id);
    this.delegateExits.delete(id);
    this.onSessionsChanged?.();
    this.hookBridge?.cleanupSession(id, hookTmpDir());
    try {
      s.proc.kill();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
    return this.sessions.get(id)?.replay ?? '';
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
}
