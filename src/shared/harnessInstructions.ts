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
- Before every dispatch, ask whether to route it to Claude (sonnet/haiku) or to Codex gpt-5.6-luna, then go.
- Before committing to an architecture decision, data migration, API design, or refactor touching 3+ files — and always once before reporting any deliverable done — consult the advisor subagent (\`Agent({subagent_type: "advisor"})\`) and act on its verdict or say plainly why you disagree.
- Never re-spawn a fresh agent to resume earlier work: continue the existing agent, or scope a new prompt to only the remaining delta. Batch related subtasks into one agent.
- Subagents and delegates must never launch this app or spawn provider CLIs themselves; they verify with typecheck and build only.

## Hygiene

- Commit and push at every step. Keep the changelog and backlog current.
- Never publish a release without an explicit go-ahead from the user.
`;
