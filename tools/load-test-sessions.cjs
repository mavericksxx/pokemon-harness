#!/usr/bin/env node
'use strict';
/**
 * Phase F ("measure it") load-test tool — spins up N concurrent "chatty"
 * pseudo-terminal sessions so a human can watch Pokéharness's CPU/FPS while
 * something resembling 15+ busy terminal sessions is running.
 *
 * WHAT THIS DOES: spawns N real pty processes with `node-pty` — the exact
 * same library main/pty.ts uses to spawn every session inside the app — each
 * running a tight shell loop that prints a timestamped line on a short
 * interval (default ~65 lines/sec/session; 15 sessions ≈ 1000 lines/sec
 * combined, comparable to a fast-scrolling coding-agent session).
 *
 * WHAT THIS DOES NOT DO: it does not drive Pokéharness's own IPC
 * (`pty:spawn` etc). That handler is only reachable from the renderer via
 * `contextBridge` (see src/preload/index.ts / src/main/index.ts) — there is
 * no scriptable "open a session" surface from outside the running app, and
 * building one is out of scope for a load-test script. So this tool
 * generates real OS-level pty/CPU/IO load standalone, alongside the app,
 * rather than literally inside it.
 *
 * HOW TO USE IT FOR A PHASE F LOAD TEST:
 *   1. Launch Pokéharness normally (`npm run dev` or the packaged app).
 *   2. In the app, open the same number of real session tabs this script is
 *      about to spawn (New Session, N times), each running the chatty
 *      command printed below — that's what actually exercises the app's own
 *      pty:data IPC channel and xterm.js rendering.
 *   3. Run this script (`node tools/load-test-sessions.cjs`) to add matching
 *      background pty/CPU load on the same machine.
 *   4. Watch: macOS Activity Monitor (Pokéharness's %CPU), the app's frame
 *      rate, and Settings → diagnostics → "rendered frames / ticks" (added
 *      alongside this tool — src/renderer/src/components/SettingsPanel.tsx)
 *      for the idle-render ratio while under load.
 *   5. Ctrl+C here (or wait for --duration to elapse) stops every spawned
 *      session and exits cleanly.
 *
 * Usage:
 *   node tools/load-test-sessions.cjs [--sessions=15] [--duration=120] [--rate-ms=15] [--cmd="..."]
 *
 *   --sessions   number of concurrent pty sessions to spawn (default 15)
 *   --duration   seconds to run before auto-stopping; 0 = run until Ctrl+C (default 0)
 *   --rate-ms    delay between lines within each session's loop, in ms (default 15)
 *   --cmd        override the per-session command entirely (e.g. "claude" or
 *                "codex" to use a real agent CLI instead of the synthetic
 *                loop below — note this is NOT wired to the app's hook
 *                bridge, so it won't drive garden/battle events, just pty
 *                output volume)
 */
const pty = require('node-pty');

function parseArgs(argv) {
  const opts = { sessions: 15, duration: 0, rateMs: 15, cmd: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'sessions') opts.sessions = Math.max(1, parseInt(value, 10) || opts.sessions);
    else if (key === 'duration') opts.duration = Math.max(0, parseInt(value, 10) || 0);
    else if (key === 'rate-ms') opts.rateMs = Math.max(1, parseInt(value, 10) || opts.rateMs);
    else if (key === 'cmd') opts.cmd = value;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const shell = process.env.SHELL || '/bin/bash';
/** Default chatty command: a plain shell loop, no external deps, that prints
 *  a timestamped line every `rateMs` milliseconds until killed. `sleep`
 *  accepts fractional seconds on macOS's BSD coreutils. */
const sleepSeconds = (opts.rateMs / 1000).toFixed(3);
const chattyLoop = `i=0; while true; do i=$((i+1)); echo "[$(date +%H:%M:%S.%3N)] chatty line $i"; sleep ${sleepSeconds}; done`;
const sessionCommand = opts.cmd ?? chattyLoop;

console.log(`[load-test] spawning ${opts.sessions} concurrent chatty pty sessions`);
console.log(`[load-test] per-session command: ${sessionCommand}`);
console.log(
  opts.duration > 0
    ? `[load-test] running for ${opts.duration}s, then stopping all sessions automatically`
    : '[load-test] running until stopped — press Ctrl+C to kill all sessions'
);
console.log('[load-test] while this runs: watch Pokéharness in Activity Monitor (CPU%), its on-screen FPS, and');
console.log('[load-test]   Settings → diagnostics → "rendered frames / ticks" for the idle-render ratio.');
console.log('[load-test] for full IPC coverage, also open this many real session tabs in the app itself, each');
console.log('[load-test]   running the command above.');
console.log('');

const sessions = [];
let totalLines = 0;

for (let i = 0; i < opts.sessions; i++) {
  const proc = pty.spawn(shell, ['-c', sessionCommand], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
  });
  proc.onData((data) => {
    totalLines += (data.match(/\n/g) || []).length;
  });
  proc.onExit(({ exitCode, signal }) => {
    console.log(`[load-test] session ${i + 1} exited (code ${exitCode}, signal ${signal ?? 'none'})`);
  });
  sessions.push(proc);
}

console.log(`[load-test] ${sessions.length} sessions live (pids: ${sessions.map((s) => s.pid).join(', ')})`);

const statusTimer = setInterval(() => {
  console.log(`[load-test] alive: ${sessions.length} sessions, ~${totalLines} lines emitted so far`);
}, 5000);

function stopAll() {
  clearInterval(statusTimer);
  console.log(`\n[load-test] stopping ${sessions.length} sessions...`);
  for (const proc of sessions) {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
  console.log('[load-test] done.');
  process.exit(0);
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

if (opts.duration > 0) setTimeout(stopAll, opts.duration * 1000);
