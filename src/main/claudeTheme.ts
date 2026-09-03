import { existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './shellEnv';
import { log } from './diagnostics';

/** Add the opt-in auto theme only when Claude has no explicit theme choice. */
export function ensureClaudeTheme(onChanged: (path: string) => void): void {
  if (!resolveCommand('claude').found) return;
  const configDir = process.env.CLAUDE_CONFIG_DIR || homedir();
  const path = join(configDir, '.claude.json');
  if (!existsSync(path)) return;

  // Dotfile managers and Claude's lock must not be bypassed by atomic replacement.
  let mode: number;
  try {
    if (lstatSync(path).isSymbolicLink() || existsSync(`${path}.lock`)) return;
    mode = statSync(path).mode & 0o777;
  } catch {
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!config || Array.isArray(config) || typeof config !== 'object' || Object.prototype.hasOwnProperty.call(config, 'theme')) {
    return;
  }

  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify({ ...config, theme: 'auto' }, null, 2)}\n`, { encoding: 'utf8', mode });
    renameSync(tempPath, path);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort cleanup */
    }
    return;
  }
  log('main', 'info', 'set claude theme to auto', { path });
  onChanged(path);
}
