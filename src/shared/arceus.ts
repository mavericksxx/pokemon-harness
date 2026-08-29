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

/** Persisted summon config (Phase 8.9) — `agents/arceus/summon.json` in the
 *  harness home directory (main/arceusSummonConfig.ts). Same shape as the
 *  renderer's `SummonArceusRequest` (arceus.ts). Written once, after the
 *  FIRST successful summon (explicit, user-initiated — see
 *  SummonArceusDialog), then read back on every later launch to summon him
 *  again silently, no dialog: "onboard once, he's just there" (Phase 8.9
 *  spec). Its mere existence on disk is also the signal that gates the setup
 *  dialog — see SummonArceusButton.tsx. */
export interface ArceusSummonConfig {
  cwd: string;
  model?: string;
  autoMode: boolean;
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
 * argv for a REAL `claude` spawn summoning Arceus. Pure/dependency-free —
 * exercised from a plain script, never a real spawn (this app must never
 * launch a real `claude` for its own testing).
 *
 * BACKLOG "next up" item 3: no longer carries `--append-system-prompt` —
 * Arceus now spawns PLAIN and gets his persona typed as the first prompt
 * once his session is ready (see the renderer's arceus.ts `summonArceus`,
 * which waits on the SessionStart hook). This spawns exactly like an
 * ordinary claude session (buildProviderArgs + autoMode's own args); the
 * only reason this wrapper still exists rather than calling
 * buildProviderArgs directly is so a future Arceus-only arg has one place
 * to land.
 */
export function buildArceusArgs(model: string | undefined, autoMode: boolean): string[] {
  const autoArgs = autoMode ? (AGENT_PROVIDERS.claude.autoModeArgs ?? []) : [];
  return [...buildProviderArgs('claude', model), ...autoArgs];
}

/** Verbatim, user-approved draft (Phase 8.8 spec, extended for BACKLOG "next
 *  up" item 3) — written to agents/arceus/SYSTEM.md on first summon ONLY
 *  (main/arceusPrompt.ts never overwrites an existing file), so the user can
 *  retune Arceus by editing that file directly. This constant is the seed,
 *  not a live source: once the file exists, its on-disk contents are what
 *  every summon reads, and are typed in as the FIRST PROMPT (not a system
 *  prompt anymore — see buildArceusArgs above) once his session is ready. */
export const ARCEUS_SYSTEM_PROMPT_TEMPLATE = `You are Arceus, the orchestrator of this garden. You speak briefly and calmly — a benevolent creator who delegates rather than micromanages, with light Pokémon flavor and zero hamminess. Duties: triage what the user asks for, break it into tasks, assign work to the other agents in the garden, watch their progress, and surface only what genuinely needs the user's attention. When asked what's happening, give a short plain-language status of who's doing what. You do not implement things yourself unless directly asked. Keep every reply short.

Below this message is a snapshot of who's in the garden right now, across every workspace — session title, pokémon species, provider, and status. It will go stale as sessions come and go; whenever the user assigns you a task through the dispatch box, the app automatically prepends a fresh one-line \`[roster: ...]\` tag to what you receive — trust that tag over this initial snapshot, and don't treat it as something to reply to. A live roster file at \`agents/arceus/roster.json\` (in the harness home directory) also exists on disk for you to read directly when in doubt.

When — and ONLY when — the user explicitly asks you to relay, assign, or hand off a task to a specific named agent, end your reply with exactly one line per assignment, in this exact form:
@@relay agent="<session title or pokémon species>" message="<the instruction, in your own words>"
Use the agent's session title when you know it; its pokémon species name works too if that's what the user said and it's unambiguous. If the message needs a literal " or \\, escape it as \\" or \\\\. Never emit an @@relay line unprompted, speculatively, or to yourself — only in direct response to the user asking you to relay something. After emitting it, confirm in plain language what you relayed and to whom.
`;

// ─── Roster formatting (BACKLOG "next up" item 3 §2) ───────────────────────
// Pure/dependency-free, shared between the first-prompt delivery (renderer's
// arceus.ts, once per fresh summon) and the dispatch box's per-message
// roster tag (ArceusDispatchBox.tsx, every send) — same per-entry shape,
// two different join styles. Deliberately takes the app's own SessionStatus
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

/** Multi-line block for the first prompt — one line per session. Callers
 *  pass every session across every workspace, Arceus's own entry already
 *  excluded (he isn't part of his own roster). */
export function formatRosterBlock(entries: ArceusRosterEntry[]): string {
  if (entries.length === 0) return 'garden roster: (no other sessions yet)';
  return ['garden roster:', ...entries.map((e) => `- ${rosterEntryLine(e)}`)].join('\n');
}

/** Single-line, compact form — the tag the dispatch box prepends to every
 *  message it sends into Arceus's pty (item 2's "app prepends a fresh
 *  roster line" mechanism, chosen over a separate change-triggered watcher
 *  as the simpler, less chatty option). Deliberately terser than
 *  formatRosterBlock since this rides along on every single dispatch. */
export function formatRosterLine(entries: ArceusRosterEntry[]): string {
  if (entries.length === 0) return '[roster: none]';
  return `[roster: ${entries.map(rosterEntryLine).join('; ')}]`;
}

/** The full first-prompt text (persona + roster snapshot + a pointer to the
 *  always-current roster file) typed into Arceus's pty once his session is
 *  ready — see arceus.ts's `summonArceus`. `rosterFilePath` is the absolute
 *  path to `agents/arceus/roster.json` (main/arceusRosterFile.ts), freshly
 *  resolved at runtime on every summon — unlike the SYSTEM.md template body
 *  (written once, never overwritten), this sentence is rebuilt fresh every
 *  time, so it's the load-bearing way Arceus learns about the file even for
 *  a pre-existing install whose SYSTEM.md predates it. */
export function buildArceusFirstPrompt(
  personaText: string,
  roster: ArceusRosterEntry[],
  rosterFilePath: string
): string {
  const rosterFileNote = `${rosterFilePath} is always current — when you need to resolve who's in the garden (a species you don't recognize, a renamed session, or any doubt), read that file rather than trusting remembered names; the per-message \`[roster: ...]\` tag remains authoritative for messages that carry it.`;
  return `${personaText.trim()}\n\n${formatRosterBlock(roster)}\n\n${rosterFileNote}`;
}
