/**
 * Arceus, the god agent (Phase 8.8) — a special orchestrator session,
 * global across every workspace (belongs to none of them; visible in all).
 * Shared between main and renderer, so this stays dependency-free (no
 * electron, no UI, no node) — same rule as agentProvider.ts.
 *
 * Singleton by construction: every summon spawns under the SAME fixed
 * session id (`ARCEUS_SESSION_ID`). pty.ts's spawn() already kills any
 * live process under a reused id before starting the new one, so reusing
 * this id is what makes "at most ONE Arceus across ALL workspaces" hold
 * without a separate registry to keep in sync.
 */
import { AGENT_PROVIDERS, buildProviderArgs } from './agentProvider';
import type { SessionRecord } from './types';

export const ARCEUS_SESSION_ID = 'arceus';

/** Dex #493 — also this line's id (dexData.ts convention: a line's id IS
 *  its stage-1 species' own id). `evolvesTo: []` in dexIndex.json already
 *  makes triggerEvolve/evolutionHint no-ops for this id, and he isn't in
 *  the bundled 42-species roster (showdownArt.ts) or any species'
 *  `evolvesTo` list, so pickFreeLine and randomAnimatedSpecies can never
 *  draw him — "never randomly picked" holds without extra filtering. */
export const ARCEUS_DEX_ID = 'arceus';

export const ARCEUS_TITLE = 'Arceus';

/** A session with no home workspace — currently just Arceus, but written
 *  against the field rather than the id so any future global session
 *  works the same way. Every per-workspace filter (roster strip, garden
 *  visibility, terminal drawer tabs, sessions overview, the workspace
 *  switcher's live/dead counts, main's workspace-delete guard) must widen
 *  "belongs to workspace X" with this check — see workspaceScope.ts. */
export function isGlobalSession(session: Pick<SessionRecord, 'isArceus'>): boolean {
  return !!session.isArceus;
}

/**
 * argv for a REAL `claude` spawn summoning Arceus. Pure/dependency-free —
 * exercised from a plain script, never a real spawn (this app must never
 * launch a real `claude` for its own testing).
 *
 * `claude --help` text: `--append-system-prompt <prompt>` — "Append a
 * system prompt to the default system prompt" — takes the prompt INLINE,
 * not a file path. The only other sighting, `--append-system-prompt[-file]`
 * inside `--bare`'s own description, is a parenthetical mention, not a
 * documented option of its own — not gambled on. So `systemPrompt` here is
 * always the FULL TEXT of agents/arceus/SYSTEM.md, read fresh by the caller
 * at every summon (main process; see main/arceusPrompt.ts) and passed
 * through verbatim — never cached in this module.
 */
export function buildArceusArgs(model: string | undefined, autoMode: boolean, systemPrompt: string): string[] {
  const autoArgs = autoMode ? (AGENT_PROVIDERS.claude.autoModeArgs ?? []) : [];
  return ['--append-system-prompt', systemPrompt, ...buildProviderArgs('claude', model), ...autoArgs];
}

/** Verbatim, user-approved draft (Phase 8.8 spec) — written to
 *  agents/arceus/SYSTEM.md on first summon ONLY (main/arceusPrompt.ts never
 *  overwrites an existing file), so the user can retune Arceus by editing
 *  that file directly. This constant is the seed, not a live source: once
 *  the file exists, its on-disk contents are what every summon reads. */
export const ARCEUS_SYSTEM_PROMPT_TEMPLATE = `You are Arceus, the orchestrator of this garden. You speak briefly and calmly — a benevolent creator who delegates rather than micromanages, with light Pokémon flavor and zero hamminess. Duties: triage what the user asks for, break it into tasks, assign work to the other agents in the garden, watch their progress, and surface only what genuinely needs the user's attention. When asked what's happening, give a short plain-language status of who's doing what. You do not implement things yourself unless directly asked. Keep every reply short.
`;
