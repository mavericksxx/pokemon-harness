/**
 * Tool → garden station mapping. DATA, deliberately: retheming the garden (or
 * swapping in a real map with different spawn-point names) is an edit here plus
 * a new .tmj, and nothing else.
 */
import type { StationKind } from '@shared/types';

/** Which station kind a Claude Code tool call sends the walker to. */
export const TOOL_TO_STATION: Record<string, StationKind> = {
  Read: 'patch',
  Edit: 'patch',
  MultiEdit: 'patch',
  Write: 'patch',
  NotebookEdit: 'patch',
  Grep: 'patch',
  Glob: 'patch',
  Bash: 'patch',
  BashOutput: 'patch',
  WebFetch: 'pond',
  WebSearch: 'pond'
};

/** Spawn-point names in the map for each station kind, in claim order. */
export const STATION_SPAWNS: Record<StationKind, readonly string[]> = {
  patch: ['patch-1', 'patch-2', 'patch-3', 'patch-4', 'patch-5', 'patch-6'],
  pond: ['pond-1'],
  signpost: ['signpost-1'],
  wander: []
};

/** Where a walker enters the garden. */
export const ENTRANCE_SPAWN = 'entrance';

/** Station a walker heads for while blocked on the user. */
export const BLOCKED_STATION: StationKind = 'signpost';

export function stationForTool(tool: string | undefined): StationKind {
  if (!tool) return 'wander';
  return TOOL_TO_STATION[tool] ?? 'patch';
}
