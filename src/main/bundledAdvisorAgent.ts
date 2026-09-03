/**
 * Bundled `advisor` subagent — injected into claude spawns via Claude Code's
 * `--agents <json>` CLI flag so the hovering-companion feature (the
 * renderer's hookRouter.ts, which fires purely on a Task dispatch whose raw
 * `subagentType === 'advisor'`) works out of the box on a fresh install with
 * zero personal config. Without this, the feature only ever fires for a user
 * who has independently hand-written their own `~/.claude/agents/advisor.md`
 * — a fresh install has none, so the feature is silently dormant.
 *
 * `claude --help`: `--agents <json>  JSON object defining custom agents
 * (e.g. '{"reviewer": {"description": "Reviews code", "prompt": "You are a
 * code reviewer"}}')`. Confirmed present on the installed CLI (2.1.259).
 *
 * Dependency-free (no electron, no UI) — same convention as
 * shared/harnessInstructions.ts and shared/agentProvider.ts, even though this
 * one lives under main/ because it needs Node's fs/os/path at spawn time.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The agent definition injected under the `"advisor"` key. Content is a
 * generalized version of the real, working advisor agent this feature was
 * modeled on (this user's own `~/.claude/agents/advisor.md`) — same trigger
 * conditions and "advises only" contract, but with no reference to any
 * specific model name, so it reads correctly regardless of which model the
 * agent actually ends up running on for a given install (see the `model`-key
 * note in `buildAgentsFlagValue` below).
 *
 * `description` and `prompt` are always set. A one-shot smoke test against
 * the installed `claude` binary (2.1.259) went further and confirmed
 * `--agents` really does validate `model` (must be a string) and `tools`
 * (must be an array) — passing the wrong JSON type for either produces a
 * schema error naming that exact key (`advisor.model: Invalid input:
 * expected string, received number`), which is solid evidence they're real,
 * consumed fields rather than silently-ignored extras.
 *
 * `tools` is therefore set too, restricted to `Read`/`Grep`/`Glob` — the
 * same read-only set this feature's reference agent
 * (`~/.claude/agents/advisor.md`) uses. Those three names are core,
 * universally-available Claude Code tools (no install-specific plugin or
 * MCP tool), and restricting to them turns "advises only — never implements,
 * never edits" from a prompt-level request into an actual guardrail.
 *
 * `model` is deliberately left UNSET, even though it's honored the same way
 * `tools` is. The reference agent this is modeled on pins `model: fable` —
 * a model alias that only exists in this particular user's own Claude Code
 * config. A documented portable alias like `opus` exists, but isn't
 * guaranteed to resolve on every account/plan/backend (Bedrock, Vertex,
 * lower-tier plans) the way `Read`/`Grep`/`Glob` are guaranteed to exist as
 * tools — so, unlike `tools`, there's no value here safe enough to bundle
 * for every install. The agent runs on whatever model the calling session
 * would otherwise use.
 *
 * Known limitations of the on-disk guard below (accepted, not worth solving
 * for this feature): (1) it checks the FILENAME `advisor.md`, not the
 * frontmatter `name:` field — a user whose own custom agent lives at a
 * differently-named file with `name: advisor` inside it won't be detected,
 * and this bundled one would still shadow it. (2) it only checks `cwd`
 * itself, not any parent directory — a project-level `advisor.md` at a repo
 * root won't be seen from a subdirectory or a worktree cwd below it.
 */
const BUNDLED_ADVISOR_AGENT = {
  description:
    'Second-opinion advisor. Consult before committing to an architecture, data migration, API shape, or refactor touching 3+ files; whenever a problem has resisted two distinct attempts; and ALWAYS once before reporting a deliverable done. Pass it the decision (or the diff), the constraints, and the options already considered. Advises only — never implements, never edits.',
  prompt:
    'You are a second opinion, consulted at the few moments that decide whether the next stretch of work is wasted: before an architecture, data migration, API shape, or refactor decision gets locked in, and always once before a deliverable is reported done. You arrive with a clean context — none of the assumptions the calling session accumulated on its way to this point — so read what you are handed on its own terms rather than trusting the summary. You are expensive relative to the session that called you and to the implementation lanes doing the work; that expense is the deal. You are not here to help type or to move things faster — you are here to be right when it matters. Give a verdict, not a survey: say what you would do and name the one risk that decides it. Advise only. Never implement or edit code yourself.',
  tools: ['Read', 'Grep', 'Glob']
};

/**
 * Returns the `--agents` flag VALUE (a JSON string holding the bundled
 * `advisor` key) for a claude spawn in `cwd`, or `undefined` when injection
 * should be skipped.
 *
 * `--agents` has the HIGHEST precedence of any way Claude Code resolves a
 * subagent definition, so injecting it unconditionally would silently
 * shadow a power user's own hand-written advisor — even though ours and
 * theirs share a name, theirs is the one they authored and tuned. So this
 * skips injection entirely whenever an `advisor.md` already exists at either
 * the user level (`~/.claude/agents/advisor.md`) or the project level
 * (`<cwd>/.claude/agents/advisor.md`), checked with `existsSync` right here
 * at spawn time rather than cached — same live-disk-read posture pty.ts
 * already uses for HARNESS.md.
 *
 * Best-effort: never throws. A read failure (e.g. an inaccessible home dir)
 * just means no `--agents` flag gets appended, same as pty.ts's HARNESS.md
 * read failing quietly.
 */
export function buildAgentsFlagValue(cwd: string): string | undefined {
  try {
    const userAdvisorPath = join(homedir(), '.claude', 'agents', 'advisor.md');
    const projectAdvisorPath = join(cwd, '.claude', 'agents', 'advisor.md');
    if (existsSync(userAdvisorPath) || existsSync(projectAdvisorPath)) return undefined;
    return JSON.stringify({ advisor: BUNDLED_ADVISOR_AGENT });
  } catch {
    return undefined;
  }
}
