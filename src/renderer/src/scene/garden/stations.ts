/**
 * Tool → garden station mapping. DATA, deliberately: retheming the garden (or
 * swapping in a real map with different spawn-point names) is an edit here plus
 * a new .tmj, and nothing else.
 *
 * Every name in STATION_SPAWNS must exist in garden.tmj's `spawn-points` object
 * group, and its prefix must be listed in TiledMapRenderer.WALKABLE_SPAWN_PREFIXES
 * so a walker can actually path onto it.
 */
import type { StationKind } from '@shared/types';

/** Which station kind a Claude Code tool call sends the walker to. */
export const TOOL_TO_STATION: Record<string, StationKind> = {
  // Reading and writing files is tending the planting beds.
  Read: 'patch',
  Edit: 'patch',
  MultiEdit: 'patch',
  Write: 'patch',
  NotebookEdit: 'patch',
  Grep: 'patch',
  Glob: 'patch',
  // Running a command is work at the felled log.
  Bash: 'stump',
  BashOutput: 'stump',
  KillShell: 'stump',
  // Reaching outside the machine is a trip to the pond.
  WebFetch: 'pond',
  WebSearch: 'pond'
};

/** Spawn-point names in the map for each station kind, in claim order. */
export const STATION_SPAWNS: Record<StationKind, readonly string[]> = {
  patch: ['patch-1', 'patch-2', 'patch-3', 'patch-4', 'patch-5', 'patch-6'],
  stump: ['stump-1', 'stump-2', 'stump-3'],
  pond: ['pond-1', 'pond-2'],
  signpost: ['signpost-1', 'mailbox-1'],
  wander: ['wander-1', 'wander-2', 'wander-3', 'wander-4']
};

/** Where a walker enters the garden. */
export const ENTRANCE_SPAWN = 'entrance';

/** Station a walker heads for while blocked on the user. */
export const BLOCKED_STATION: StationKind = 'signpost';

export function stationForTool(tool: string | undefined): StationKind {
  if (!tool) return 'wander';
  return TOOL_TO_STATION[tool] ?? 'patch';
}
