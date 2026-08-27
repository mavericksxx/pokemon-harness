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
 * with `AGENT_ID` (set on the child's env — see pty.ts), and forwards it over
 * a Unix domain socket this class listens on. We normalize the payload and
 * push it to the renderer over `hooks:event:<agentId>`; the shim always gets
 * `{}` back (this app never denies/gates a tool call at the hook boundary).
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
import {
  isKnownHookEvent,
  toolTargetFromInput,
  type HookEvent,
  type HookPayload
} from '../shared/hookEvents';

/** Env var the shim reads to find the UDS to dial. */
export const HOOK_SOCK_ENV = 'POKE_HOOK_SOCK';
/** Env var the shim stamps onto every payload as `agent_id`. */
export const AGENT_ID_ENV = 'AGENT_ID';

const SHIM_FILENAME = 'cth-hook.cjs';

/** The generated shim script. Deliberately dumb: read stdin, add agent_id
 *  from env, forward to the socket, print whatever comes back (Claude expects
 *  hook stdout to be either empty or a JSON hookSpecificOutput blob), exit.
 *  Never blocks longer than a few seconds even if the app is gone. */
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.${AGENT_ID_ENV} || null;
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
  private readonly launcherFile: string;
  readonly sockPath: string;

  constructor(
    userDataDir: string,
    private getWebContents: () => WebContents | null
  ) {
    this.binDir = join(userDataDir, 'hooks-bin');
    this.shimFile = join(this.binDir, SHIM_FILENAME);
    this.launcherFile = join(this.binDir, process.platform === 'win32' ? 'poke-node.cmd' : 'poke-node');
    this.sockPath = join(userDataDir, 'hooks.sock');
  }

  /** Write the shim + bundled-node launcher. Idempotent, refreshed every call
   *  so a code change always takes effect on the next app start. */
  ensureFiles(): void {
    mkdirSync(this.binDir, { recursive: true });
    writeFileSync(this.shimFile, HOOK_SHIM, 'utf8');
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
        } catch {
          /* malformed line — respond empty rather than hang the shim */
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
    this.server.on('error', (e) => console.error('[hooks] socket server error:', e));
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
        SubagentStop: [entry()]
      }
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return settingsPath;
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
    const agentId = p.agent_id ?? undefined;
    const eventName = p.hook_event_name ?? 'Unknown';
    if (!agentId) return {}; // no session to route to — drop silently
    if (!isKnownHookEvent(eventName)) return {};

    const event: HookEvent = {
      agentId,
      event: eventName,
      tool: p.tool_name,
      toolTarget: toolTargetFromInput(p.tool_name, p.tool_input),
      notificationType: p.notification_type,
      message: p.message,
      source: p.source
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
}
