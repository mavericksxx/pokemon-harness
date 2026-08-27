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
  // pond-island is out in the water; see AIR_ONLY_SPAWNS below.
  pond: ['pond-1', 'pond-2', 'pond-island', 'pond-3'],
  signpost: ['signpost-1', 'mailbox-1'],
  wander: ['wander-1', 'wander-2', 'wander-3', 'wander-4']
};

/**
 * Spawns only a flying or levitating Pokemon can reach. A walker offered one
 * would simply never move, so these are filtered out for it.
 *
 * The generator asserts this both ways: every other spawn must be reachable on
 * foot from the entrance, and each of these must NOT be.
 */
export const AIR_ONLY_SPAWNS: ReadonlySet<string> = new Set(['pond-island']);

/** Where a walker enters the garden. */
export const ENTRANCE_SPAWN = 'entrance';

/** Station a walker heads for while blocked on the user. */
export const BLOCKED_STATION: StationKind = 'signpost';

export function stationForTool(tool: string | undefined): StationKind {
  if (!tool) return 'wander';
  return TOOL_TO_STATION[tool] ?? 'patch';
}
