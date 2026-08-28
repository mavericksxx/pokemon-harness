/**
 * Tool -> move SFX vocabulary (Phase 7). Mirrors `stations.ts`'s
 * tool->station table in spirit: a plain data map, kept in sync with the
 * curated files `tools/curate-sfx.cjs` extracts into assets/audio/sfx/.
 *
 * Each tool maps to a small pool (1-4 clips) so repeated attacks with the
 * same tool don't sound identical every time; one is picked at random per
 * call. Unlisted/unknown tools (and Task, which drives battle SPAWNS rather
 * than in-battle attacks) fall back to FALLBACK_SFX.
 */
import type { SfxKey } from './sfxAssets';

const TOOL_SFX: Record<string, SfxKey[]> = {
  // Reading/searching a scratch or peck-ish hit.
  Read: ['Peck'],
  Grep: ['Scratch'],
  Glob: ['Scratch'],
  // Editing files is a clean Cut.
  Edit: ['Cut', 'Psycho_Cut'],
  MultiEdit: ['Cut', 'Psycho_Cut'],
  Write: ['Cut', 'Psycho_Cut'],
  NotebookEdit: ['Cut', 'Psycho_Cut'],
  // Running a command is a punch/strike.
  Bash: ['Mach_Punch', 'Comet_Punch_1hit', 'Pound', 'Slam'],
  BashOutput: ['Mach_Punch', 'Pound'],
  KillShell: ['Slam'],
  // Reaching outside the machine is a whoosh/gust.
  WebFetch: ['Gust', 'Whirlwind'],
  WebSearch: ['Gust', 'Whirlwind'],
  // A subagent Task call is a summon.
  Task: ['Teleport']
};

/** Generic fallback hit for any tool not listed above. */
const FALLBACK_SFX: SfxKey[] = ['Tackle', 'Confusion', 'Struggle', 'Water_Gun', 'Ember'];

function pick(pool: SfxKey[]): SfxKey {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The move-sound to play for one rendered attack lunge using `tool`. */
export function sfxKeyForTool(tool: string): SfxKey {
  return pick(TOOL_SFX[tool] ?? FALLBACK_SFX);
}

/** Battle victory — a short, pleasant chime. */
export const VICTORY_SFX: SfxKey = 'Heal_Bell';

/** Evolution ceremony's soft riser, played at ceremony start (alongside — not
 *  instead of — any music crossfade). */
export const EVOLUTION_RISER_SFX: SfxKey = 'Growth';
