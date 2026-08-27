/**
 * Resolve the user's real shell PATH.
 *
 * Trimmed port of munder-difflin's `src/main/shellEnv.ts` (MIT, Chaitanya Giri),
 * macOS/Linux only (this app targets darwin).
 *
 * WHY: an Electron app launched from Finder/Dock does NOT inherit the PATH the
 * user's interactive shell builds (nvm / asdf / homebrew / volta all live in
 * rc-file exports), so a bare `claude` would ENOENT even though it works fine in
 * a terminal. We capture PATH once from a login shell and reuse it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fence markers: rc-file chatter (greetings, version managers printing) would
 *  otherwise be indistinguishable from the value we asked for. */
const BEGIN = '__PH_BEGIN__';
const END = '__PH_END__';

/** Run one command through the user's LOGIN+INTERACTIVE shell and return only
 *  the fenced output, or null. Never throws. */
export function captureFromLoginShell(command: string): string | null {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const res = spawnSync(shell, ['-ilc', `printf %s "${BEGIN}"; ${command}; printf %s "${END}"`], {
      encoding: 'utf8',
      timeout: 8000
    });
    const out = res.stdout ?? '';
    const a = out.indexOf(BEGIN);
    const b = out.indexOf(END, a + BEGIN.length);
    if (a === -1 || b === -1) return null;
    return out.slice(a + BEGIN.length, b);
  } catch {
    return null;
  }
}

let cachedPath: string | null = null;

/** The user's interactive-shell PATH, captured once per app run. */
export function userShellPath(): string {
  if (cachedPath !== null) return cachedPath;
  const shellPath = captureFromLoginShell('printf %s "$PATH"')?.trim();
  // A PATH is a single colon-joined line. Anything multi-line is rc-file noise
  // that slipped the fence — fall back rather than hand the child a corrupt PATH.
  cachedPath = shellPath && !shellPath.includes('\n') ? shellPath : process.env.PATH || '';
  return cachedPath;
}

/** A plain executable name — the only shape we resolve against PATH. A resolver
 *  interpolates this into a shell string, so it is constrained to characters
 *  that are unambiguously part of a binary name. */
export function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(command);
}

/** `~/foo` → `/Users/me/foo`. Leaves everything else untouched. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const resolved = new Map<string, { path: string; found: boolean }>();

/** Resolve a bare command against the user's PATH + common install locations.
 *  `found` is false when nothing was located (spawn would then ENOENT). Only
 *  positive results are cached, so an install between spawns is picked up. */
export function resolveCommand(command: string): { path: string; found: boolean } {
  const hit = resolved.get(command);
  if (hit && existsSync(hit.path)) return hit;
  const res = resolveCommandUncached(command);
  if (res.found) resolved.set(command, res);
  else resolved.delete(command);
  return res;
}

function resolveCommandUncached(command: string): { path: string; found: boolean } {
  if (command.includes('/')) return { path: command, found: existsSync(command) };
  if (!isSafeCommandName(command)) return { path: command, found: false };

  const which = captureFromLoginShell(`which ${command}`);
  if (which) {
    const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (path && existsSync(path)) return { path, found: true };
  }

  const home = homedir();
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `/usr/bin/${command}`,
    `/bin/${command}`,
    join(home, '.local', 'bin', command),
    join(home, '.claude', 'local', command),
    join(home, '.volta', 'bin', command),
    join(home, '.bun', 'bin', command)
  ];
  for (const c of candidates) if (existsSync(c)) return { path: c, found: true };

  return { path: command, found: false };
}
