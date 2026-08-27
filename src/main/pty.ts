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
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandTilde, resolveCommand, userShellPath } from './shellEnv';
import { AGENT_ID_ENV, HOOK_SOCK_ENV, type HookBridge } from './hookBridge';
import type { PtyInfo, PtyResult, SpawnPtyOptions } from '../shared/types';

/** Where per-session hook settings.json files live — plain OS temp, not
 *  userData: these are throwaway routing files, not app state. */
function hookTmpDir(): string {
  return join(tmpdir(), 'pokemon-harness-hooks');
}

interface PtySession {
  id: string;
  proc: pty.IPty;
  cwd: string;
  command: string;
  /** Epoch ms of the most recent byte this PTY emitted. */
  lastOutputAt: number;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private webContents: WebContents | null = null;

  /** Phase 4 Part A — optional so tests/other providers spawn unchanged when
   *  it's absent. */
  constructor(private hookBridge?: HookBridge) {}

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

  spawn(opts: SpawnPtyOptions): PtyResult {
    const cwd = expandTilde(opts.cwd);
    if (!existsSync(cwd)) return { ok: false, error: `cwd does not exist: ${cwd}` };

    // A respawn reusing a live id would orphan the old child. Kill it first.
    if (this.sessions.has(opts.id)) this.kill(opts.id);

    const { path: file, found } = resolveCommand(opts.command);
    if (!found) {
      return { ok: false, error: `command not found on PATH: ${opts.command}` };
    }

    // Phase 4 Part A — wire the Claude Code hooks shim for claude sessions
    // only: a per-session --settings file routes lifecycle hooks over a UDS
    // back to this app, so the garden can use them as the authoritative state
    // source instead of scraping terminal text. Other providers are unaffected.
    let args = opts.args ?? [];
    let hookEnv: Record<string, string> = {};
    if (opts.provider === 'claude' && this.hookBridge) {
      const settingsPath = this.hookBridge.prepareSession(opts.id, hookTmpDir());
      args = [...args, '--settings', settingsPath];
      hookEnv = { [AGENT_ID_ENV]: opts.id, [HOOK_SOCK_ENV]: this.hookBridge.sockPath };
    }

    try {
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          PATH: userShellPath(),
          TERM: 'xterm-256color',
          LANG: process.env.LANG || 'en_US.UTF-8',
          ...(opts.env ?? {}),
          ...hookEnv
        }
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
        lastOutputAt: Date.now()
      };
      this.sessions.set(opts.id, session);

      proc.onData((data) => {
        if (this.sessions.get(opts.id) !== session) return;
        session.lastOutputAt = Date.now();
        this.safeSend(`pty:data:${opts.id}`, data);
      });

      proc.onExit(({ exitCode, signal }) => {
        if (this.sessions.get(opts.id) !== session) return;
        this.sessions.delete(opts.id);
        this.safeSend(`pty:exit:${opts.id}`, { exitCode, signal });
      });

      return { ok: true, cwd };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
    if (!s) return { ok: false, error: `no pty: ${id}` };
    // Delete BEFORE killing: onExit fires asynchronously and its identity guard
    // then correctly treats the dying process as stale.
    this.sessions.delete(id);
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
