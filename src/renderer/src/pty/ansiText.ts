/**
 * Strip ANSI escape sequences from scraped terminal output.
 *
 * Ported VERBATIM from munder-difflin (src/renderer/src/components/ansiText.ts),
 * MIT, Chaitanya Giri.
 *
 * The pty parser must see plain text: the CLI repaints its live status line with
 * cursor-forward moves (`ESC[1C`) standing in for runs of spaces it knows are
 * already on screen, plus cursor addressing and erases. Scraped naively that
 * renders as "all[1Cthree[1Cland…".
 *
 * Cursor-forward is TRANSLATED into the spaces it stands for (dropping it would
 * fuse adjacent words); everything else is control, not content, and is removed.
 */
const CUF_RE = /\x1b\[(\d*)C/g; // cursor-forward: the TUI's stand-in for spaces
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // OSC … BEL/ST (titles, links)
const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g; // any CSI: SGR, cursor, erase, modes
const CHARSET_RE = /\x1b[()][0-9A-B]/g; // charset selects (ESC ( B …)
const ESC2_RE = /\x1b./g; // stray two-byte escapes (ESC 7, ESC = …)

export function stripAnsi(chunk: string): string {
  return chunk
    .replace(CUF_RE, (_, n: string) => ' '.repeat(Math.min(parseInt(n || '1', 10) || 1, 80)))
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CHARSET_RE, '')
    .replace(ESC2_RE, '');
}

/**
 * A pty write can split an escape sequence across two chunks (`ESC[3` in one
 * read, `2m` in the next). `stripAnsi` is stateless, so the head is dropped and
 * the tail renders as literal text. The stream stripper holds the unfinished
 * tail of a chunk and prepends it to the next one.
 *
 * The carry is bounded: a lone ESC that is never completed must not buffer
 * forever, so past MAX_CARRY it is flushed through the stateless stripper as-is.
 */
export const MAX_CARRY = 256;

const PARTIAL_TAIL_RE = /^\x1b(?:\[[0-9;:?]*[ -/]*|\][^\x07\x1b]*|[()])?$/;

export function createAnsiStripper(): (chunk: string) => string {
  let carry = '';
  return (chunk: string): string => {
    let input = carry + chunk;
    carry = '';
    const esc = input.lastIndexOf('\x1b');
    if (esc !== -1) {
      const tail = input.slice(esc);
      if (PARTIAL_TAIL_RE.test(tail) && tail.length <= MAX_CARRY) {
        carry = tail;
        input = input.slice(0, esc);
      }
    }
    return stripAnsi(input);
  };
}
