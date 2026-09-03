import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
    writeFileSync(tempPath, `${JSON.stringify({ ...config, theme: 'auto' }, null, 2)}\n`, 'utf8');
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
