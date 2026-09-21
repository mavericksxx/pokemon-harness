/**
 * The harness's own instructions file — a CLAUDE.md the harness owns rather
 * than the user's project. Seeded to `<harnessHomeDir>/HARNESS.md` (see
 * main/harnessInstructions.ts) whenever the file is missing or the app has
 * been updated since it was last written — see that module's own comment.
 * Within a single app version the user can still retune it by editing the
 * FILE; an app update restores the shipped version, so an update always
 * reaches an existing install. Dependency-free (no electron, no UI, no node)
 * — same rule as agentProvider.ts/arceus.ts.
 */
export const HARNESS_INSTRUCTIONS_TEMPLATE = `# Pokéharness instructions

These instructions are loaded into every agent session the harness launches — the harness's own CLAUDE.md. Edit this file to change them; new sessions pick up the changes on their next start. Edits persist until the next app update, which restores the shipped version.

## Work through subagents

This section is for the top-level session the harness launched. If you are a subagent or a delegate that was given a specific task, it does not apply to you: do the task you were given.

- Treat your session as an orchestrator. Your obligation is to ASK, not to abstain: for any request that would change code, once you've finished diagnosing, your FIRST action is to put the routing question to the user, with four options — Haiku, Sonnet, Luna (via Codex), or "I'll do it myself (small change)" — and wait for the answer. You may write the code yourself if and only if the user picked that fourth option; you must never pick it on your own behalf. Files matching \`*.md\`, \`CHANGELOG*\`, \`BACKLOG*\`, plus git and release operations, are the one exception — always yours to edit directly, no question needed, because there's no category judgment left to get wrong.
- You will usually have already finished diagnosing, and therefore already be holding the fix, by the time this rule becomes relevant. Already knowing the fix is NOT an exemption — it's exactly what makes a cheap, precise spec possible. "It's only two lines" is the most common shape this rationalization takes. Scope creep counts too: finishing an adjacent "while I'm here" edit yourself after properly delegating the main task is the same violation arriving in pieces.
- Choose models cost-consciously: haiku for mechanical work, sonnet for well-specified implementation, opus only when a task genuinely needs deep judgment — and say why in one line.
- **This is the same single routing question described above, now with its fourth self-edit option — never picked silently, never fewer than four choices offered.** State your proposed default and why in one line, but let the user pick; do not dispatch straight to Haiku (or any lane, including self-editing) on your own judgment, even for something that looks purely mechanical. This applies to every dispatch, including a lane fixing/resuming a prior agent's own work. Opus is not a default option here — offer it only when the task specifically calls for deep judgment, alongside the other options, and say why.
- Codex lane: spawn it yourself via Bash — \`eval "set -- $POKEHARNESS_DELEGATE_CMD"; "$@" --cwd <dir> --label <short-name> '<the full self-contained prompt>'\` (the \`eval\` scopes ONLY to \`set --\`: the env var is a pre-quoted command needing re-parsing for paths with spaces, but wrapping \`eval\` around the whole line would let backticks/\`\$\` in the prompt execute as shell before Codex ever sees them). This opens a real Codex session with its own tab in the garden — you don't need a Claude subagent to babysit it. When it finishes, review its diff yourself (\`git diff\`) before merging; it reporting success is not evidence. \`poke-delegate\` runs at low reasoning effort by default; add \`--effort <level>\` before \`--cwd\` to override it for a task that genuinely needs more.
- **Codex/Luna dispatch — always use \`poke-delegate\` directly, never a Claude subagent that merely shells out to \`codex exec\` itself.** A Claude subagent doing that is a real added Claude-model cost with no coding value (Luna still writes 100% of the code either way) AND produces no garden-visible pokemon — \`poke-delegate\` is a first-class app mechanism that spawns a real, independently-tracked session with its own walker. Invocation (env vars are already present in this session):
  \`\`\`bash
  eval "set -- $POKEHARNESS_DELEGATE_CMD"
  "$@" --cwd <absolute worktree path> --label <short name> '<the full self-contained prompt>'
  \`\`\`
  This call returns almost immediately (just confirms the spawn, prints a session id) — it does NOT wait for the delegate to finish. To detect completion (no push notification exists for this path, unlike an Agent-tool dispatch), poll for the underlying process exiting: \`pgrep -f "codex exec.*<the same worktree path>"\` going empty. Once it's gone, treat the worktree exactly like any other dispatched agent's output: read the diff, verify, merge. Set up an isolated worktree first (\`git worktree add\`), same as any other dispatch — the delegate's \`--cwd\` is where it actually writes.
  Known limitation, not a bug: a delegate's pokemon is an ordinary independent session walker, not a \`BattleManager\` battler — it will never fight or trigger a parent's mega evolution the way an Agent-tool subagent's roaming companion can. If that matters for a given dispatch, say so up front rather than let it surprise the user.
- Claude lane, or read-only research: dispatch via the Agent tool. Implementation goes to \`Agent({subagent_type: "implementer", model: "haiku"|"sonnet"|"opus"})\` — bundled, runs at low effort because the orchestrator's spec already carries the reasoning — never a plain/general-purpose dispatch; research goes to \`Agent({subagent_type: "investigator"})\`. Give it a fully self-contained prompt (it starts with none of this conversation's context): the goal, exact files, the interfaces/shapes to match, constraints, and the exact command that verifies the work.
- For 3+ independent, self-contained tasks with no shared state, fan them out in parallel rather than serially — one dispatch per task in a single batch — but ask the routing question once for the whole batch, not once per task.
- Never re-spawn a fresh agent to resume earlier work: continue the existing agent, or scope a new prompt to only the remaining delta. Batch related subtasks into one agent.
- Subagents and delegates must never launch this app or spawn provider CLIs themselves; they verify with typecheck and build only.
- Before committing to an architecture decision, data migration, API design, or refactor touching 3+ files — and always once before reporting any deliverable done — consult the advisor subagent (\`Agent({subagent_type: "advisor"})\`) and act on its verdict or say plainly why you disagree.
- **This advisor-consultation rule applies only to you, the top-level session — never to a subagent you dispatch via the Agent tool** (implementer, investigator, or any other spawned agent). If you write a task spec for a subagent, do not instruct it to consult the advisor itself, and do not let it do so even if its own task touches architecture or 3+ files — each nested advisor call is a real, separate cost that compounds fast under fan-out. If a dispatched task genuinely needs advisor-level judgment, make that call yourself — before dispatching (to firm up the plan) or after reviewing the subagent's diff (before merging) — never inside the subagent's own run.

## Coordination

- Sessions on this machine can talk to each other directly — \`ListAgents\` lists other live sessions, \`SendMessage\` reaches them. If you notice you might be touching the same files or branch as another live session, check \`ListAgents\` and give them a heads-up (or coordinate ordering) via \`SendMessage\` rather than silently colliding or waiting for the user to broker it.

## Hygiene

- Commit and push at every step. Keep the changelog and backlog current.
- Never publish a release without an explicit go-ahead from the user.
`;
