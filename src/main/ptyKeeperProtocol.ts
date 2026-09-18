/**
 * Minimal length-prefixed frame protocol between a detached session's
 * "keeper" helper process (ptyKeeper.ts) and the main process's KeeperClient
 * adapter (pty.ts) — shared so both sides encode/decode identically. Kept in
 * its own file (rather than inline in either) since both entry points need
 * it: the keeper bundle (out/main/ptyKeeper.js) and the main bundle
 * (out/main/index.js) are built from SEPARATE electron-vite entries (see
 * electron.vite.config.ts), so this is the one module both are allowed to
 * share without pulling either entry's runtime into the other's.
 *
 * Frame = [1-byte type][4-byte BE payload length][payload bytes].
 */

/** Server (keeper) → client: raw pty output bytes — the backlog once, right
 *  after connect, then live bytes as they arrive. */
export const FRAME_DATA = 0;
/** Client → server: bytes to write to the pty master (renderer input). */
export const FRAME_WRITE = 1;
/** Client → server: kill the real child process. No payload. */
export const FRAME_KILL = 2;
/** Server → client: the real child exited (fd 3 hit EOF), or the keeper
 *  itself is giving up. Payload = JSON `{ exitCode, signal }` — see
 *  ptyKeeper.ts's own comment on why these are always best-effort
 *  placeholders, never the child's real wait() status. */
export const FRAME_EXIT = 3;
/** Client → server: resize the real pty. Payload = 8 bytes, `cols` then
 *  `rows` as big-endian UInt32s (see `encodeResizePayload`/`decodeResizePayload`
 *  below) — a reattaching client's terminal is only ever a handful of
 *  columns/rows, so a fixed binary layout is simpler than a JSON round trip
 *  for something this small and this hot (one reattach can fire this twice
 *  in quick succession — see pty.ts's `KeeperClient.resize`). Reattach-fix
 *  (garbled Claude Code TUI on "leave them running" relaunch) — the keeper
 *  only inherits a raw fd (see ptyKeeper.ts's header), so unlike every other
 *  frame here this one needs a real ioctl on that fd, not just a write. */
export const FRAME_RESIZE = 4;

/** `FRAME_RESIZE`'s payload codec — shared so `pty.ts` (encode) and
 *  `ptyKeeper.ts` (decode) can't drift on byte order. */
export function encodeResizePayload(cols: number, rows: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(Math.max(1, Math.floor(cols)), 0);
  payload.writeUInt32BE(Math.max(1, Math.floor(rows)), 4);
  return payload;
}

export function decodeResizePayload(payload: Buffer): { cols: number; rows: number } | null {
  if (payload.length < 8) return null;
  return { cols: payload.readUInt32BE(0), rows: payload.readUInt32BE(4) };
}

/** Same rough sizing idea as pty.ts's own REPLAY_MAX_CHARS — a detached
 *  session's backlog serves the exact same purpose `session.replay` does for
 *  a live one: letting a reconnecting Electron backfill what it missed. */
export const KEEPER_REPLAY_MAX_CHARS = 200_000;

const HEADER_BYTES = 5;

export function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
  type: number;
  payload: Buffer;
}

/** Streaming decoder — a socket 'data' chunk can split a frame anywhere (or
 *  bundle several), so this buffers across calls until whole frames are
 *  available. One instance per socket connection. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: DecodedFrame[] = [];
    while (this.buf.length >= HEADER_BYTES) {
      const type = this.buf.readUInt8(0);
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < HEADER_BYTES + len) break;
      frames.push({ type, payload: this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len) });
      this.buf = this.buf.subarray(HEADER_BYTES + len);
    }
    return frames;
  }
}
