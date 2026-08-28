/**
 * Terminal QoL settings (font size, scrollback depth — Phase 8.5 Wave B item
 * 3), persisted as a plain JSON file under userData. Same shape as
 * audioSettings.ts (that file's header explains why this app follows a
 * plain-JSON-under-userData pattern rather than a new dependency).
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clampTerminalSettings, DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '../shared/terminalTypes';

function settingsPath(): string {
  return join(app.getPath('userData'), 'terminal-settings.json');
}

export async function loadTerminalSettings(): Promise<TerminalSettings> {
  const p = settingsPath();
  if (!existsSync(p)) return { ...DEFAULT_TERMINAL_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<TerminalSettings>;
    return clampTerminalSettings({ ...DEFAULT_TERMINAL_SETTINGS, ...raw });
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }
}

export async function saveTerminalSettings(settings: TerminalSettings): Promise<void> {
  const p = settingsPath();
  await mkdir(join(app.getPath('userData')), { recursive: true });
  await writeFile(p, JSON.stringify(clampTerminalSettings(settings)));
}
