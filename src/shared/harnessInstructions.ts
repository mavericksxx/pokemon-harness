/**
 * The harness's own instructions file — a CLAUDE.md the harness owns rather
 * than the user's project. Seeded to `<harnessHomeDir>/HARNESS.md` (see
 * main/harnessInstructions.ts) the first time it's needed, exactly the way
 * arceusPrompt.ts seeds `agents/arceus/SYSTEM.md` from
 * ARCEUS_SYSTEM_PROMPT_TEMPLATE: written ONCE, never overwritten after, so
 * the user can retune it by editing the FILE. Dependency-free (no electron,
 * no UI, no node) — same rule as agentProvider.ts/arceus.ts.
 */
export const HARNESS_INSTRUCTIONS_TEMPLATE = `# Pokéharness instructions

These instructions are loaded into every agent session the harness launches — the harness's own CLAUDE.md. Edit this file to change them; new sessions pick up the changes on their next start.

## Work through subagents

This section is for the top-level session the harness launched. If you are a subagent or a delegate that was given a specific task, it does not apply to you: do the task you were given.

- Treat your session as an orchestrator. Do not write project code yourself; delegate implementation, research, and mechanical work to subagents (the Agent tool) or delegates (\`poke-delegate\` for Codex), then review, verify, and merge their output. Docs, changelog, backlog, merges, and release operations are yours to do directly.
- Choose models cost-consciously: haiku for mechanical work, sonnet for well-specified implementation, opus only when a task genuinely needs deep judgment — and say why in one line.
- **Before every dispatch, always present the user a real choice among Haiku, Sonnet, and Luna (gpt-5.6, via Codex) — never fewer than three, never picked silently.** State your proposed default and why in one line, but let the user pick; do not dispatch straight to Haiku (or any lane) on your own judgment, even for something that looks purely mechanical. This applies to every dispatch, including a lane fixing/resuming a prior agent's own work. Opus is not a default option here — offer it only when the task specifically calls for deep judgment, alongside the other three, and say why.
- Codex lane: spawn it yourself via Bash — \`eval "set -- $POKEHARNESS_DELEGATE_CMD"; "$@" --cwd <dir> --label <short-name> '<the full self-contained prompt>'\` (the \`eval\` scopes ONLY to \`set --\`: the env var is a pre-quoted command needing re-parsing for paths with spaces, but wrapping \`eval\` around the whole line would let backticks/\`\$\` in the prompt execute as shell before Codex ever sees them). This opens a real Codex session with its own tab in the garden — you don't need a Claude subagent to babysit it. When it finishes, review its diff yourself (\`git diff\`) before merging; it reporting success is not evidence.
- **Codex/Luna dispatch — always use \`poke-delegate\` directly, never a Claude subagent that merely shells out to \`codex exec\` itself.** A Claude subagent doing that is a real added Claude-model cost with no coding value (Luna still writes 100% of the code either way) AND produces no garden-visible pokemon — \`poke-delegate\` is a first-class app mechanism that spawns a real, independently-tracked session with its own walker. Invocation (env vars are already present in this session):
  \`\`\`bash
  eval "set -- $POKEHARNESS_DELEGATE_CMD"
  "$@" --cwd <absolute worktree path> --label <short name> '<the full self-contained prompt>'
  \`\`\`
  This call returns almost immediately (just confirms the spawn, prints a session id) — it does NOT wait for the delegate to finish. To detect completion (no push notification exists for this path, unlike an Agent-tool dispatch), poll for the underlying process exiting: \`pgrep -f "codex exec.*<the same worktree path>"\` going empty. Once it's gone, treat the worktree exactly like any other dispatched agent's output: read the diff, verify, merge. Set up an isolated worktree first (\`git worktree add\`), same as any other dispatch — the delegate's \`--cwd\` is where it actually writes.
  Known limitation, not a bug: a delegate's pokemon is an ordinary independent session walker, not a \`BattleManager\` battler — it will never fight or trigger a parent's mega evolution the way an Agent-tool subagent's roaming companion can. If that matters for a given dispatch, say so up front rather than let it surprise the user.
- Claude lane, or read-only research: dispatch via the Agent tool — \`Agent({subagent_type: "investigator"})\` for research, otherwise a plain dispatch. Give it a fully self-contained prompt (it starts with none of this conversation's context): the goal, exact files, the interfaces/shapes to match, constraints, and the exact command that verifies the work.
- For 3+ independent, self-contained tasks with no shared state, fan them out in parallel rather than serially — one dispatch per task in a single batch — but ask the routing question once for the whole batch, not once per task.
- Never re-spawn a fresh agent to resume earlier work: continue the existing agent, or scope a new prompt to only the remaining delta. Batch related subtasks into one agent.
- Subagents and delegates must never launch this app or spawn provider CLIs themselves; they verify with typecheck and build only.
- Before committing to an architecture decision, data migration, API design, or refactor touching 3+ files — and always once before reporting any deliverable done — consult the custom advisor subagent (\`~/.claude/agents/advisor.md\`, run via \`Agent({subagent_type: "advisor"})\`, Fable 5.1) and act on its verdict or say plainly why you disagree.
- **This advisor-consultation rule applies only to you, the top-level session — never to a subagent you dispatch via the Agent tool** (implementer, investigator, or any other spawned agent). If you write a task spec for a subagent, do not instruct it to consult the advisor itself, and do not let it do so even if its own task touches architecture or 3+ files — each nested advisor call is a real, separate cost that compounds fast under fan-out. If a dispatched task genuinely needs advisor-level judgment, make that call yourself — before dispatching (to firm up the plan) or after reviewing the subagent's diff (before merging) — never inside the subagent's own run.

## Hygiene

- Commit and push at every step. Keep the changelog and backlog current.
- Never publish a release without an explicit go-ahead from the user.
`;
