/**
 * ptyKeeper — standalone helper process for the "leave them running" quit
 * path (QuitDialog.tsx's 5th action).
 *
 * Spawned via ELECTRON_RUN_AS_NODE (same launcher pattern as hookBridge.ts's
 * node launcher — see pty.ts's `detachToKeeper`), NOT part of the normal
 * main-process bundle's runtime flow: this is its own electron-vite entry
 * (electron.vite.config.ts), built to a sibling `out/main/ptyKeeper.js`, and
 * only ever imported by pty.ts as a path string to spawn, never as a module.
 *
 * The mechanism (validated experimentally, not just reasoned about — see
 * this feature's design doc): closing the LAST open reference to a pty
 * master sends a hangup to the slave side regardless of whether anyone
 * explicitly signals it — even a child wrapped to ignore SIGHUP still dies
 * within ~1s of its pty-owning parent exiting, because the terminal itself
 * goes dead (writes start failing), not just a signal. But a SEPARATE
 * process holding its own open reference to the same master keeps the
 * underlying open-file-description alive indefinitely, independent of
 * whatever happens to the process that originally owned it. That's this
 * file's entire job: inherit the master fd at fd 3 (wired by the parent at
 * spawn time, see pty.ts's `detachToKeeper`) and just... keep it open.
 *
 * Everything else here exists to make that useful instead of just inert:
 * drain fd 3 continuously into a bounded backlog (regardless of whether
 * anyone's connected — otherwise the real CLI blocks once the pty's kernel
 * buffer fills), and serve it over a Unix socket so a relaunched Electron
 * can reattach (get the backlog, then live bytes; send input/kill back).
 * Exits — cleaning up its own socket file first — once fd 3 hits EOF (the
 * real child exited on its own) or on its own unexpected read/listen error;
 * no exit status is ever persisted anywhere (see FRAME_EXIT's own comment
 * in ptyKeeperProtocol.ts for why that's fine).
 */
import { createServer, type Socket } from 'node:net';
import { createReadStream, existsSync, unlinkSync, writeSync } from 'node:fs';
import {
  FRAME_DATA,
  FRAME_EXIT,
  FRAME_KILL,
  FRAME_WRITE,
  FrameDecoder,
  KEEPER_REPLAY_MAX_CHARS,
  encodeFrame
} from './ptyKeeperProtocol';

// argv: [execPath, thisScript, sockPath, childPid] — see pty.ts's
// `detachToKeeper` for how these are chosen/passed. Kept minimal on
// purpose: this process needs nothing else (session metadata like
// cwd/command/env lives in a sidecar file PtyManager itself reads back on
// reattach — this process has no use for any of it).
const [, , sockPath, pidArg] = process.argv;
const childPid = Number(pidArg);

/** Inherited from the parent at spawn time (see pty.ts's `detachToKeeper`'s
 *  `stdio` array) — this fd IS the mechanism, see this file's header. */
const PTY_FD = 3;

if (!sockPath || !Number.isFinite(childPid)) {
  process.exit(1);
}

let backlog = '';
let exiting = false;
const clients = new Set<Socket>();

function broadcast(frame: Buffer): void {
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      /* dead client — its own 'close'/'error' listener drops it below */
    }
  }
}

function cleanupAndExit(code: number): void {
  if (exiting) return;
  exiting = true;
  try {
    server.close();
  } catch {
    /* already closed */
  }
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    /* best-effort */
  }
  process.exit(code);
}

// Stale socket from a keeper that died uncleanly (hard kill, machine sleep
// weirdness) — same self-heal idea as hookBridge.ts's own socket inode
// check: a fresh keeper for the same id always starts by clearing it, so a
// leftover file can never make THIS keeper fail to bind.
try {
  if (existsSync(sockPath)) unlinkSync(sockPath);
} catch {
  /* best-effort */
}

const server = createServer((socket) => {
  clients.add(socket);
  // Backlog first, before anything else — a reattaching client always gets
  // a full, ordered replay before any live bytes could interleave with it.
  if (backlog) socket.write(encodeFrame(FRAME_DATA, Buffer.from(backlog, 'utf8')));
  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === FRAME_WRITE) {
        // Fire-and-forget: an occasional dropped write to a background,
        // detached session (e.g. the pty's input queue momentarily full) is
        // an acceptable V1 edge case, not worth a full backpressure queue
        // in a process whose only reason to exist is to keep an fd open.
        try {
          writeSync(PTY_FD, frame.payload);
        } catch {
          /* pty gone or backpressured — best-effort */
        }
      } else if (frame.type === FRAME_KILL) {
        // The real child's pid, not this process's own — this process
        // never forked it (node-pty did, inside the ORIGINAL Electron
        // process), it only inherited the master fd. See pty.ts's
        // `detachToKeeper` for why this is confirmed to be the real pid.
        try {
          process.kill(childPid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});
server.on('error', () => cleanupAndExit(1));
server.listen(sockPath);

// Drain fd 3 continuously — regardless of whether anything is connected, or
// the real CLI blocks once the pty's kernel buffer fills. `''` as the path
// arg is ignored by fs once `fd` is set; `autoClose: false` so this stream
// closing (e.g. on our own exit) never closes the fd out from under
// anything else that might still reference it.
const readStream = createReadStream('', { fd: PTY_FD, autoClose: false });
readStream.setEncoding('utf8');
readStream.on('data', (chunk) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  backlog = (backlog + text).slice(-KEEPER_REPLAY_MAX_CHARS);
  broadcast(encodeFrame(FRAME_DATA, Buffer.from(text, 'utf8')));
});
readStream.on('end', () => {
  // Real child exited on its own. exitCode is always a best-effort
  // placeholder (0) — this process isn't the child's actual OS parent
  // (node-pty forked it from inside the ORIGINAL Electron process, which
  // owns/reaps it; once that process exits the child reparents to init),
  // so there's no wait() status this keeper could ever observe. pty.ts's
  // own natural-exit handling (shared with every other session via
  // `wireSessionHandlers`) never branches on the exact code/signal, only on
  // isFallback/isDelegate/shellFallbackEnabled — a placeholder is enough to
  // make that handling (shell fallback, delegate-exit retention, GitHub #8
  // unregister) fire correctly instead of a reattached session just going
  // silently, permanently quiet.
  broadcast(encodeFrame(FRAME_EXIT, Buffer.from(JSON.stringify({ exitCode: 0 }), 'utf8')));
  cleanupAndExit(0);
});
readStream.on('error', () => cleanupAndExit(1));
