/**
 * Audio bus settings (master mute, music on/off + volume, SFX on/off +
 * volume — Phase 7), persisted as a plain JSON file under userData.
 *
 * No settings-persistence precedent existed anywhere else in the app before
 * this (grepped: no electron-store dependency, no renderer localStorage use
 * — every existing userData write is main-owned binary asset caching, e.g.
 * spriteCache.ts). This follows that same shape rather than introducing a
 * new dependency or pattern for five scalar values.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../shared/audioTypes';

function settingsPath(): string {
  return join(app.getPath('userData'), 'audio-settings.json');
}

export async function loadAudioSettings(): Promise<AudioSettings> {
  const p = settingsPath();
  if (!existsSync(p)) return { ...DEFAULT_AUDIO_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<AudioSettings>;
    // Merge over defaults so an older settings file missing a newly-added key
    // doesn't produce `undefined` for it.
    return { ...DEFAULT_AUDIO_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export async function saveAudioSettings(settings: AudioSettings): Promise<void> {
  const p = settingsPath();
  await mkdir(join(app.getPath('userData')), { recursive: true });
  await writeFile(p, JSON.stringify(settings));
}
