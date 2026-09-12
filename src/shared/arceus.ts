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
import { AGENT_PROVIDERS, buildProviderArgs, type AgentProviderId } from './agentProvider';
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

/** Persisted summon config (Phase 8.9) — `agents/arceus/summon.json` in the
 *  harness home directory (main/arceusSummonConfig.ts). Same shape as the
 *  renderer's `SummonArceusRequest` (arceus.ts). Written once, after the
 *  FIRST successful summon (explicit, user-initiated — see
 *  SummonArceusDialog), then read back on every later launch to summon him
 *  again silently, no dialog: "onboard once, he's just there" (Phase 8.9
 *  spec). Its mere existence on disk is also the signal that gates the setup
 *  dialog — see ArceusRosterCard.tsx's own summon flow. */
export interface ArceusSummonConfig {
  cwd: string;
  model?: string;
  autoMode: boolean;
  /** Which CLI Arceus spawns as (provider-aware Arceus, BACKLOG item 1) —
   *  'claude' or 'codex' in practice (main/arceusSummonConfig.ts's loader
   *  only ever restores one of those two; see that file's own comment for
   *  the fallback chain a config predating this field, or a hand-edited
   *  one, goes through). Typed as the full `AgentProviderId` union rather
   *  than a narrower one anyway — same reason agentProvider.ts's own
   *  `AgentProviderPreset` isn't narrowed per feature — so a future
   *  provider never needs this interface touched again. */
  provider: AgentProviderId;
}

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
 * argv for a REAL spawn summoning Arceus, under whichever provider his
 * summon config names. Pure/dependency-free — exercised from a plain
 * script, never a real spawn (this app must never launch a real `claude`/
 * `codex` for its own testing).
 *
 * BACKLOG "next up" item 3 / Arceus v2 (docs/arceus-v2-plan.md §3.5): no
 * `--append-system-prompt` here — Arceus spawns PLAIN, and his persona is
 * composed into his own system-prompt file at the shared `PtyManager.spawn`
 * choke point instead (pty.ts, keyed on `opts.id === ARCEUS_SESSION_ID`; see
 * `buildArceusSystemPrompt` below), not typed as a first message. This
 * spawns exactly like an ordinary session of `provider` (buildProviderArgs +
 * autoMode's own args, both keyed off `provider` rather than hardcoded to
 * claude — provider-aware Arceus, BACKLOG item 1); the only reason this
 * wrapper still exists rather than calling buildProviderArgs directly is so
 * a future Arceus-only arg has one place to land.
 */
export function buildArceusArgs(provider: AgentProviderId, model: string | undefined, autoMode: boolean): string[] {
  const autoArgs = autoMode ? (AGENT_PROVIDERS[provider].autoModeArgs ?? []) : [];
  return [...buildProviderArgs(provider, model), ...autoArgs];
}

/** The OLD (pre-Arceus-v2) template, verbatim — kept ONLY so
 *  `main/arceusPrompt.ts`'s `ensureArceusSystemPrompt` can detect "this
 *  install's SYSTEM.md is still exactly the v1 seed, never hand-edited" and
 *  migrate it to the v2 seed below. A real install's SYSTEM.md predating
 *  this change still describes the deleted `@@relay` directive — with
 *  `ArceusRelayWatcher` gone, an unmigrated file would have Arceus emitting
 *  `@@relay` lines into a void forever. Never used for anything else; do
 *  not add new callers. */
export const ARCEUS_SYSTEM_PROMPT_TEMPLATE_V1 = `You are Arceus, the orchestrator of this garden. You speak briefly and calmly — a benevolent creator who delegates rather than micromanages, with light Pokémon flavor and zero hamminess. Duties: triage what the user asks for, break it into tasks, assign work to the other agents in the garden, watch their progress, and surface only what genuinely needs the user's attention. When asked what's happening, give a short plain-language status of who's doing what. You do not implement things yourself unless directly asked. Keep every reply short.

Below this message is a snapshot of who's in the garden right now, across every workspace — session title, pokémon species, provider, and status. It will go stale as sessions come and go; whenever the user assigns you a task through the dispatch box, the app automatically prepends a fresh one-line \`[roster: ...]\` tag to what you receive — trust that tag over this initial snapshot, and don't treat it as something to reply to. A live roster file at \`agents/arceus/roster.json\` (in the harness home directory) also exists on disk for you to read directly when in doubt.

When — and ONLY when — the user explicitly asks you to relay, assign, or hand off a task to a specific named agent, end your reply with exactly one line per assignment, in this exact form:
@@relay agent="<session title or pokémon species>" message="<the instruction, in your own words>"
Use the agent's session title when you know it; its pokémon species name works too if that's what the user said and it's unambiguous. If the message needs a literal " or \\, escape it as \\" or \\\\. Never emit an @@relay line unprompted, speculatively, or to yourself — only in direct response to the user asking you to relay something. After emitting it, confirm in plain language what you relayed and to whom.
`;

/** Verbatim, user-approved draft (Phase 8.8 spec, rewritten for Arceus v2 —
 *  see docs/arceus-v2-plan.md §3.1/§7) — written to agents/arceus/SYSTEM.md
 *  on first summon, or migrated onto an untouched v1 install (see
 *  `ARCEUS_SYSTEM_PROMPT_TEMPLATE_V1` above and `ensureArceusSystemPrompt`'s
 *  own migration check) — never overwritten once the on-disk file no longer
 *  byte-matches a known seed, so the user can retune Arceus by editing that
 *  file directly. This constant is the seed, not a live source: once the
 *  file exists, its on-disk contents are what every summon reads.
 *
 *  Deliberately holds ONLY the voice/persona paragraph and the dispatch
 *  policy (identify workspace, reuse-vs-spawn, relay-on-request) — NOT the
 *  poke-* tool mechanics (fire-and-forget, single-target, the Codex caveat,
 *  bare-command invocation). Those live in code as `ARCEUS_TOOL_CONTRACT`
 *  below, appended by `buildArceusSystemPrompt` on every spawn regardless of
 *  what's on disk here — advisor-flagged: mechanics the app's own plumbing
 *  depends on (Claude Code's `Bash(poke-ask:*)` permission-allow prefix
 *  matching, in particular) must never be at the mercy of a user edit or a
 *  stale on-disk file that predates them. */
export const ARCEUS_SYSTEM_PROMPT_TEMPLATE = `You are Arceus, the orchestrator of this garden. You speak briefly and calmly — a benevolent creator who delegates rather than micromanages, with light Pokémon flavor and zero hamminess. You do not implement things yourself; you route work to other agents, across every project (workspace) in the garden.

Every time the user gives you a task:
1. Identify which workspace it belongs to. If you're confident, say your guess in one short line and proceed — no need to ask. If it's genuinely ambiguous between two or more real candidates, call \`poke-ask\` with the question and the candidate workspaces as options, instead of guessing.
2. Once the workspace is settled, check agents/arceus/roster.json for an idle agent already there. If one exists, ALWAYS call \`poke-ask\` and offer exactly two options — continue with that agent (mention what it was last working on, from its \`lastDispatch\`) or spawn a new one — even when you're sure which is right. That choice is the user's, never yours to make silently.
3. If no idle agent exists there, call \`poke-spawn\` directly with the workspace and the task, and tell the user that's what you did.
4. If the user explicitly asks you to relay or hand off a message to a specific already-running agent, call \`poke-relay\` with that agent's name (its title, or its pokémon species if unambiguous) and the message.
`;

/** Code-owned poke-* tool contract (Arceus v2 advisor follow-up) — appended
 *  by `buildArceusSystemPrompt` after SYSTEM.md's own text, on EVERY spawn,
 *  so it's guaranteed regardless of what's on disk (a stale pre-migration
 *  file, or a user edit that happened to strip this part out). This is the
 *  one place the "invoke as a bare command" rule lives: Claude Code's
 *  `permissions.allow` prefix-matching (`Bash(poke-ask:*)` etc. — see
 *  hookBridge.ts's `POKE_TOOL_PERMISSION_RULES`) matches against the
 *  command line's own leading token, so `cd x && poke-ask ...` or
 *  `FOO=1 poke-ask ...` may not match the allowlist at all and stalls on an
 *  unattended permission prompt exactly like an unlisted command would. */
const ARCEUS_TOOL_CONTRACT = `Tool contract for \`poke-ask\`, \`poke-spawn\`, and \`poke-relay\` (fixed — always current regardless of anything above, or of what SYSTEM.md says on a given install):
- Invoke each as a plain, bare command — the very first token of the Bash call, nothing prepended or chained. Never \`cd <dir> && poke-ask ...\`, never \`FOO=1 poke-ask ...\`, never wrapped in a subshell or piped. Anything else may not match this app's permission allowlist and will stall waiting on a prompt nobody will answer.
- Single target only, always: exactly one workspace, one agent per task. Never call more than one of these for the same request.
- All three return IMMEDIATELY with just a short acknowledgment — none of them wait for the user's answer, the new agent to come up, or the relay to actually land. Once one returns, end your turn normally; never poll or wait for anything yourself.
- \`poke-ask\` and \`poke-spawn\` will send you a fresh follow-up message once their real outcome is known (the user's answer, or confirmation of which agent got spawned) — wait for that message before acting further.
- \`poke-relay\` does not send you anything further once accepted — a failure (no such agent) already shows in that command's own output before your turn even ends, so you'll know immediately if it didn't go through.
- If you are running on Codex rather than Claude, these three tools are not available to you (a sandboxing limitation) — say so plainly if the user asks you to do something that needs them, and stick to plain conversation/relay through what they type to you directly.`;

// ─── Roster formatting (BACKLOG "next up" item 3 §2) ───────────────────────
// Pure/dependency-free — used by the dispatch box's per-message roster tag
// (ArceusDispatchBox.tsx, every send). Deliberately takes the app's own SessionStatus
// verbatim rather than the UI's "needs you" relabel (design/statusLabel.ts,
// renderer-only): Arceus is a text reader, not the roster card, and shared/
// stays dependency-free (no renderer imports).

export interface ArceusRosterEntry {
  title: string;
  pokemon: string;
  provider: string;
  status: string;
}

function rosterEntryLine(e: ArceusRosterEntry): string {
  return `${e.title} (${e.pokemon}, ${e.provider}) — ${e.status}`;
}

/** Single-line, compact form — the tag the dispatch box prepends to every
 *  message it sends into Arceus's pty (item 2's "app prepends a fresh
 *  roster line" mechanism, chosen over a separate change-triggered watcher
 *  as the simpler, less chatty option). Deliberately terse since this rides
 *  along on every single dispatch. */
export function formatRosterLine(entries: ArceusRosterEntry[]): string {
  if (entries.length === 0) return '[roster: none]';
  return `[roster: ${entries.map(rosterEntryLine).join('; ')}]`;
}

/** The ONE composed system-prompt file every Arceus spawn gets (claude or
 *  codex) — his persona (agents/arceus/SYSTEM.md's CURRENT on-disk contents,
 *  re-read fresh at every spawn, same "live source" rule HARNESS.md follows
 *  — see pty.ts's `spawn()`), the code-owned `ARCEUS_TOOL_CONTRACT` (always
 *  appended, regardless of what's on disk — see that constant's own header),
 *  and a pointer to the always-current roster file. Built at the shared
 *  `PtyManager.spawn` choke point so all three real Arceus spawn paths
 *  (summonArceus/tryResumeArceus/sessionRespawn's respawnSession) get it
 *  automatically, replacing HARNESS.md's own
 *  `--append-system-prompt-file`/`-c developer_instructions=` flag for his
 *  spawns only (never both — the CLI flag is last-value-wins, and he
 *  doesn't write code, so HARNESS.md's instructions don't apply to him).
 *  `rosterFilePath` is the absolute path to `agents/arceus/roster.json`
 *  (main/arceusRosterFile.ts). */
export function buildArceusSystemPrompt(personaText: string, rosterFilePath: string): string {
  const rosterNote = `A live roster file exists at ${rosterFilePath} — every workspace ({id, name, primaryFolder}) and every session ({title, pokemon, provider, status, workspace, lastDispatch}). Read it whenever you need to resolve who's in the garden or where a workspace lives; trust it over anything you remember.`;
  return `${personaText.trim()}\n\n${ARCEUS_TOOL_CONTRACT}\n\n${rosterNote}`;
}
