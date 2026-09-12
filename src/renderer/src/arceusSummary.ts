/**
 * Arceus v2 ambient status (docs/arceus-v2-plan.md §3.6) — a free,
 * deterministic, RULE-BASED one-line summary plus the full per-agent board,
 * both composed straight from the renderer's own live session/workspace
 * state (the same data `roster.json` is written from — see
 * `main/arceusRosterFile.ts` — just read here from the renderer's own store
 * instead of shelling out to the file). No model call of any kind (§6 —
 * that was explicitly cut): every sentence below is plain string-template
 * logic over `SessionRecord` fields already in memory.
 *
 * Exact phrasing/grouping rules aren't pinned down anywhere upstream (plan
 * §8 leaves this to implementation) — this file is that implementation:
 * group by status, name the most notable few agents individually (priority
 * order: blocked > working > done > idle > starting, matching how urgently
 * each one plausibly wants the user's attention), and fold anything past
 * that into a plain count so the sentence stays one line even in a busy
 * garden.
 */
import type { Session } from '@/store/store';
import type { WorkspaceRecord } from '@shared/workspaceTypes';
import { sessionWorkspaceId } from '@/store/workspaceStore';
import { speciesEntry } from '@/scene/garden/dexData';
import { statusSinceMs } from '@/arceusStatusHistory';

/** Arceus routes/watches every workspace at once — same cross-workspace
 *  scope `toRosterEntries` (arceus.ts) and `writeArceusRosterFile`
 *  (main/arceusRosterFile.ts) already use for his own roster, so the HUD
 *  shows the identical population he'd read off `roster.json`. */
function relevantAgents(sessions: Session[]): Session[] {
  return sessions.filter((s) => !s.isArceus && !s.isPlainTerminal);
}

function displayName(session: Session): string {
  return speciesEntry(session.pokemon)?.name ?? session.pokemon;
}

function truncate(text: string, max = 42): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** "1m" / "34m" / "1h 12m" — deliberately coarse (no seconds): this labels
 *  ambient status, not a stopwatch. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

interface SummaryAgent {
  name: string;
  status: Session['status'];
  statusMs: number;
  lastDispatchMessage?: string;
}

function toSummaryAgent(session: Session): SummaryAgent {
  return {
    name: displayName(session),
    status: session.status,
    statusMs: statusSinceMs(session),
    lastDispatchMessage: session.lastDispatch?.message
  };
}

function describeAgent(agent: SummaryAgent): string {
  const { name, status, lastDispatchMessage: task } = agent;
  switch (status) {
    case 'working':
      return task ? `${name}'s working on "${truncate(task)}"` : `${name}'s working`;
    case 'blocked':
      return `${name}'s been blocked for ${formatDuration(agent.statusMs)} and probably wants a look`;
    case 'idle':
      return task
        ? `${name} wrapped up "${truncate(task)}" and has been idle ${formatDuration(agent.statusMs)}`
        : `${name}'s been idle for ${formatDuration(agent.statusMs)}`;
    case 'done':
      return `${name} just wrapped up cleanly`;
    case 'starting':
      return `${name}'s just getting started`;
    default:
      return `${name}'s ${status}`;
  }
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Most-notable-first — how urgently each status plausibly wants the
 *  user's attention, not alphabetical or creation order. */
const STATUS_PRIORITY: Record<Session['status'], number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  starting: 4
};

/** Individually named agents cap here so the sentence stays one line even
 *  in a busy garden — anything past this folds into a trailing count. */
const MAX_NAMED_AGENTS = 3;

export function composeArceusSummary(sessions: Session[]): string {
  const agents = relevantAgents(sessions).map(toSummaryAgent);
  if (agents.length === 0) {
    return 'No other agents in the garden yet — dispatch a task below to get one started.';
  }
  const sorted = [...agents].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
  const named = sorted.slice(0, MAX_NAMED_AGENTS);
  const rest = sorted.slice(MAX_NAMED_AGENTS);

  const clauses = named.map(describeAgent);
  if (rest.length > 0) {
    const counts = new Map<Session['status'], number>();
    for (const r of rest) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    for (const [status, count] of counts) {
      clauses.push(`${count} more ${status}`);
    }
  }
  return `${joinWithAnd(clauses)}.`;
}

export interface ArceusBoardRow {
  id: string;
  name: string;
  glyph: string;
  projectLabel: string;
  /** Real `SessionStatus` — one of all five real values (starting/idle/
   *  working/blocked/done), even while `label` below reads "napping" — so
   *  the pill's CSS class always resolves to a real color (every one of the
   *  five has its own `.hud-pill-*` rule). */
  status: Session['status'];
  /** What the pill actually shows — "napping" overrides the raw status
   *  text (a plain-shell session gone quiet, or a claude session between a
   *  compact and its next SessionStart — see `SessionRecord.napping`'s own
   *  comment) since that reads more useful than "idle" here; duration is
   *  appended for every status except "working"/"starting", matching the
   *  mockup's own pill copy. */
  label: string;
}

export function buildArceusBoardRows(sessions: Session[], workspaces: WorkspaceRecord[]): ArceusBoardRow[] {
  const workspaceById = new Map(workspaces.map((w) => [w.id, w] as const));
  return relevantAgents(sessions).map((session) => {
    const name = displayName(session);
    const workspace = workspaceById.get(sessionWorkspaceId(session));
    const projectLabel = `${workspace?.name ?? 'unknown project'} · ${session.provider}`;
    const showsDuration = session.status !== 'working' && session.status !== 'starting';
    const statusText = session.napping ? 'napping' : session.status;
    const label = showsDuration ? `${statusText} ${formatDuration(statusSinceMs(session))}` : statusText;
    return {
      id: session.id,
      name,
      glyph: name.slice(0, 3).toLowerCase(),
      projectLabel,
      status: session.status,
      label
    };
  });
}
