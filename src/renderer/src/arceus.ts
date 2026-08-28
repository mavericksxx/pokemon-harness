/**
 * Arceus, the god agent (Phase 8.8) — the summon flow. Mirrors sessions.ts's
 * `startSession`/`stopSession` shape (create the terminal first, add the
 * store entry, spawn, undo both on failure) but under the fixed
 * `ARCEUS_SESSION_ID` (shared/arceus.ts) rather than a fresh id per call —
 * that fixed id is what makes "at most ONE Arceus across ALL workspaces"
 * hold: pty.ts's spawn() already kills any live process under a reused id
 * before starting the new one.
 *
 * NEVER spawns a real claude session for this app's own testing (repo
 * rule). `summonArceus` is the real path (a genuine `claude`, persona typed
 * in as his first prompt once his session is ready — BACKLOG "next up" item
 * 3, replacing the old `--append-system-prompt` flag); `summonArceusDevStandin`
 * swaps that for a plain shell tagged `isArceus`, gated by main's
 * `config:arceusDevStandin` (POKE_ARCEUS_DEV_STANDIN=1) — see the dialog,
 * which picks between them. Everything but the real claude spawn (the
 * cosmos ascent, alpha card, dispatch box, persistence, cross-workspace
 * presence) is exercisable through the stand-in.
 */
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import {
  ARCEUS_DEX_ID,
  ARCEUS_SESSION_ID,
  ARCEUS_TITLE,
  buildArceusArgs,
  buildArceusFirstPrompt,
  type ArceusRosterEntry,
  type ArceusSummonConfig
} from '@shared/arceus';
import { useStore, type Session } from '@/store/store';
import { createTerminal, disposeTerminal, hasTerminal } from '@/pty/terminalRegistry';

export interface SummonArceusRequest {
  cwd: string;
  model?: string;
  autoMode: boolean;
}

function arceusRecord(): Session | undefined {
  return useStore.getState().sessions.find((s) => s.id === ARCEUS_SESSION_ID);
}

/** A live (status !== 'done') Arceus exists — same "live" definition
 *  WorkspaceSwitcher's own live/dead counts use. The summon action selects
 *  him instead of spawning again while this holds. */
export function arceusIsLive(): boolean {
  const s = arceusRecord();
  return !!s && s.status !== 'done';
}

export function selectArceus(): void {
  useStore.getState().select(ARCEUS_SESSION_ID);
}

async function spawnArceus(
  command: string,
  args: string[],
  provider: AgentProviderId,
  req: SummonArceusRequest
): Promise<void> {
  // A previous, now-finished Arceus record (status 'done') is replaced
  // outright — addSession below would otherwise push a SECOND entry under
  // the same id rather than updating the existing one.
  const existing = arceusRecord();
  if (existing) useStore.getState().removeSession(existing.id);
  if (hasTerminal(ARCEUS_SESSION_ID)) disposeTerminal(ARCEUS_SESSION_ID);

  let sessionAdded = false;
  try {
    createTerminal(ARCEUS_SESSION_ID, provider);
    useStore.getState().addSession({
      id: ARCEUS_SESSION_ID,
      title: ARCEUS_TITLE,
      cwd: req.cwd,
      command,
      provider,
      model: req.model,
      pokemon: ARCEUS_DEX_ID,
      line: ARCEUS_DEX_ID,
      shiny: false,
      isArceus: true
      // workspaceId deliberately omitted — Arceus is global (Phase 8.8 §7).
    });
    sessionAdded = true;

    const res = await window.api.spawnPty({
      id: ARCEUS_SESSION_ID,
      cwd: req.cwd,
      command,
      args,
      cols: 100,
      rows: 30,
      provider
    });
    if (!res.ok) throw new Error(res.error ?? 'failed to summon Arceus.');
    useStore.getState().updateSession(ARCEUS_SESSION_ID, { status: 'idle', cwd: res.cwd ?? req.cwd });
  } catch (err) {
    if (hasTerminal(ARCEUS_SESSION_ID)) disposeTerminal(ARCEUS_SESSION_ID);
    if (sessionAdded) useStore.getState().removeSession(ARCEUS_SESSION_ID);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** How long a fresh Arceus summon waits for the SessionStart hook before
 *  delivering the persona anyway (BACKLOG item 3 §1) — hooks going quiet is
 *  a documented possibility elsewhere in this app (hookRouter.ts's own
 *  HOOK_SILENCE_MS fallback), and a session that never gets its persona
 *  would otherwise sit mute forever. Generous backstop, not the expected
 *  path — SessionStart fires within milliseconds of the CLI being up on
 *  every real hook observation this app relies on elsewhere. */
const FIRST_PROMPT_FALLBACK_MS = 10_000;

/** Wraps text in the bracketed-paste escape sequence (`ESC[200~ … ESC[201~`)
 *  so its internal newlines land as literal multi-line content in Arceus's
 *  input box instead of each one submitting a fragment early (the way a bare
 *  `\r` would) — the same mechanism a bracketed-paste-aware terminal app
 *  uses for a pasted multi-line block. The caller still appends a single
 *  trailing `\r` after this to actually press Enter and submit the whole
 *  paste as one turn. UNVERIFIED against a live CLI (this app must never
 *  spawn a real claude session for its own testing) — if Claude Code's
 *  input box doesn't honor bracketed paste the way assumed here, this is the
 *  first place to look. */
function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Session list -> roster entries (shared/arceus.ts's `formatRosterBlock`/
 *  `formatRosterLine`) — every session across every workspace, Arceus's own
 *  entry excluded. Exported for ArceusDispatchBox.tsx, which prepends the
 *  same roster (in its compact one-line form) to every message it sends. */
export function toRosterEntries(sessions: Session[]): ArceusRosterEntry[] {
  return sessions
    .filter((s) => !s.isArceus)
    .map((s) => ({ title: s.title, pokemon: s.pokemon, provider: s.provider, status: s.status }));
}

/** Arms delivery of the persona + roster snapshot as Arceus's first typed
 *  prompt. FRESH SUMMONS ONLY — this is called from `summonArceus` alone,
 *  never from `spawnArceus` itself (shared by both real and dev-standin
 *  paths) or from any restore path, which is what keeps a resumed Arceus
 *  from getting his persona typed at him a second time as if it were a new
 *  user message:
 *   - a same-process reload/crash recovery re-adopts an already-running pty
 *     via `createTerminal(id, provider, replay)` (main.tsx's boot()) and
 *     never calls `summonArceus` at all;
 *   - a full app quit + relaunch respawns a disk-persisted Arceus session
 *     via main's `respawnSession`, whose `respawnArgs` (sessionRespawn.ts)
 *     returns `['--resume', claudeSessionId]` for a claude session with a
 *     captured id — never re-passing the persona either, and never routed
 *     through this file at all (that respawn happens main-side, before the
 *     renderer's `restoreSessions` even reattaches the terminal).
 *  So `summonArceus` — reached only for a genuinely fresh conversation, from
 *  `SummonArceusDialog`'s first-ever summon, `autoSummonArceus`'s silent
 *  re-summon when he isn't live, or the topbar chip — is the one path that
 *  should ever get this. */
function armFirstPromptDelivery(personaText: string): void {
  let delivered = false;
  let offHook: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deliver = (): void => {
    if (delivered) return;
    delivered = true;
    offHook?.();
    if (timer !== null) clearTimeout(timer);
    const roster = toRosterEntries(useStore.getState().sessions);
    const prompt = buildArceusFirstPrompt(personaText, roster);
    void window.api.writePty(ARCEUS_SESSION_ID, wrapBracketedPaste(prompt) + '\r');
  };

  offHook = window.api.onHookEvent(ARCEUS_SESSION_ID, (evt) => {
    if (evt.event === 'SessionStart') deliver();
  });
  timer = setTimeout(deliver, FIRST_PROMPT_FALLBACK_MS);
}

/** Real summon — a genuine `claude` session, spawned PLAIN (no
 *  `--append-system-prompt`); agents/arceus/SYSTEM.md's CURRENT contents
 *  (re-read fresh here every call; see main/arceusPrompt.ts) are instead
 *  typed in as his first prompt once his session reports ready — see
 *  `armFirstPromptDelivery` above. */
export async function summonArceus(req: SummonArceusRequest): Promise<void> {
  const { path, prompt } = await window.api.ensureArceusSystemPrompt();
  if (!prompt.trim()) {
    throw new Error(`${path} is empty — write Arceus's instructions there and summon again.`);
  }
  const args = buildArceusArgs(req.model, req.autoMode);
  await spawnArceus(AGENT_PROVIDERS.claude.defaultCommand, args, 'claude', req);
  armFirstPromptDelivery(prompt);
}

/** Dev-only stand-in — see this file's header. Gated at the call site
 *  (SummonArceusDialog) on `config:arceusDevStandin`, not here. */
export async function summonArceusDevStandin(req: SummonArceusRequest): Promise<void> {
  const shell = await window.api.getDefaultShell();
  await spawnArceus(shell, [], 'shell', req);
}

// ─── Summon-once (Phase 8.9) ────────────────────────────────────────────────
// "arceus should only have to be onboarded the first time" — the ORIGINAL
// summon (below, from SummonArceusDialog) stays explicit/user-initiated and
// is the only thing that WRITES agents/arceus/summon.json. Every later
// launch (main.tsx boot(), and the topbar chip if he's ever not live) reads
// it back and re-summons him silently. Note (BACKLOG item 3): this silent
// re-summon is only free when it resumes a disk-persisted session
// (sessionRespawn.ts's `--resume`, main-side, never routed through
// `summonArceus`) — a genuinely FRESH re-summon now sends the persona as a
// real first prompt (`armFirstPromptDelivery` above) and so does cost a
// turn, same as any other fresh Arceus conversation.
export function loadArceusSummonConfig(): Promise<ArceusSummonConfig | null> {
  return window.api.getArceusSummonConfig();
}

/** Called once, right after a successful FIRST summon — see
 *  SummonArceusDialog's submit handler, the only caller. */
export function saveArceusSummonConfig(config: ArceusSummonConfig): Promise<void> {
  return window.api.saveArceusSummonConfig(config);
}

/** Settings' "reset arceus" action — returns the app to first-run behavior
 *  (does not touch a currently-live Arceus session, if any; only clears the
 *  saved config so the NEXT time he isn't live, the setup dialog shows
 *  again instead of a silent auto-summon). */
export function resetArceusSummonConfig(): Promise<void> {
  return window.api.resetArceusSummonConfig();
}

export type AutoSummonOutcome = 'summoned' | 'no-config' | 'failed';

/** Summons Arceus from the saved config, picking real vs. dev-standin the
 *  same way SummonArceusDialog does. Used both at launch (main.tsx boot(),
 *  when he isn't among the restored sessions) and from the topbar chip
 *  (SummonArceusButton, when he's saved-but-not-live). Never throws —
 *  `'failed'` covers claude missing from PATH, a dead `--resume` AND a
 *  failed fresh spawn, or any other spawn error; the caller turns that into
 *  a quiet toast, never a dialog. */
export async function autoSummonArceus(): Promise<AutoSummonOutcome> {
  const config = await loadArceusSummonConfig();
  if (!config) return 'no-config';
  try {
    const devStandin = await window.api.getArceusDevStandin();
    if (devStandin) await summonArceusDevStandin(config);
    else await summonArceus(config);
    return 'summoned';
  } catch (err) {
    console.error('[arceus] auto-summon failed:', err);
    return 'failed';
  }
}

// ─── Relay toast (BACKLOG "next up" item 3 §3, §6) ──────────────────────────
// The relay directive itself is watched and resolved main-side
// (main/arceusRelay.ts, tailing Arceus's own transcript) — main already owns
// the pty writes and the session-list mirror it needs to resolve a name.
// The one thing only the renderer can do is the toast, so main sends just
// the failure case over `arceus:relayUnresolved` and this turns it into one.

/** Subscribes once to unresolved-relay-target notices and turns each into a
 *  toast. Call once, from main.tsx's boot(), same as sessions.ts's
 *  `startRegistrySync`/`startCompletionToasts`. */
export function startArceusRelayToasts(): void {
  window.api.onArceusRelayUnresolved((name) => {
    useStore.getState().pushToast(`arceus tried to reach '${name}' — no such agent`);
  });
}
