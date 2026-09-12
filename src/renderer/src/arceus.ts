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
 * rule). `summonArceus` is the real path (a genuine `claude`/`codex`, persona
 * composed into his own system-prompt file at the shared `PtyManager.spawn`
 * choke point — see pty.ts and shared/arceus.ts's `buildArceusSystemPrompt` —
 * Arceus v2, docs/arceus-v2-plan.md §3.5); `summonArceusDevStandin` swaps
 * that for a plain shell tagged `isArceus`, gated by main's
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
  type ArceusRosterEntry,
  type ArceusSummonConfig
} from '@shared/arceus';
import { useStore, type Session } from '@/store/store';
import { createTerminal, disposeTerminal, hasTerminal, recreateTerminal } from '@/pty/terminalRegistry';
import { safeLogDiagnostic } from '@/diagnosticsClient';
import { RESUME_GRACE_MS } from '@shared/resumeTiming';

export interface SummonArceusRequest {
  cwd: string;
  model?: string;
  autoMode: boolean;
  /** Provider-aware Arceus (BACKLOG item 1) — 'claude' or 'codex' in
   *  practice; same shape as (and always what's persisted into)
   *  shared/arceus.ts's `ArceusSummonConfig`. */
  provider: AgentProviderId;
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

  // Mirrors sessions.ts's `startSession`: `addSession` below selects Arceus
  // by default, so a failed summon must not leave whatever was selected
  // before this call permanently swapped out for a session that's about to
  // be torn down again in the catch block.
  const previousSelectedId = useStore.getState().selectedId;
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
    if (sessionAdded) {
      useStore.getState().removeSession(ARCEUS_SESSION_ID);
      if (previousSelectedId && useStore.getState().sessions.some((session) => session.id === previousSelectedId)) {
        useStore.getState().select(previousSelectedId);
      }
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Wraps text in the bracketed-paste escape sequence (`ESC[200~ … ESC[201~`)
 *  so its internal newlines land as literal multi-line content in a CLI's
 *  input box instead of each one submitting a fragment early (the way a bare
 *  `\r` would) — the same mechanism a bracketed-paste-aware terminal app
 *  uses for a pasted multi-line block. The caller still appends a single
 *  trailing `\r` after this to actually press Enter and submit the whole
 *  paste as one turn. Callers (Arceus v2): PokeAskModal.tsx (the user's
 *  answer, injected into Arceus's own pty) and sessions.ts's `adoptPokeSpawn`
 *  (a `poke-spawn`'s initial task, injected into the freshly spawned
 *  session's own pty). UNVERIFIED against a live CLI (this app must never
 *  spawn a real claude/codex session for its own testing) — if a CLI's input
 *  box doesn't honor bracketed paste the way assumed here, this is the first
 *  place to look. */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Session list -> roster entries (shared/arceus.ts's `formatRosterLine`) —
 *  every session across every workspace, Arceus's own entry excluded.
 *  Exported for ArceusDispatchBox.tsx, which prepends the same roster (in
 *  its compact one-line form) to every message it sends. */
export function toRosterEntries(sessions: Session[]): ArceusRosterEntry[] {
  return sessions
    .filter((s) => !s.isArceus && !s.isPlainTerminal)
    .map((s) => ({ title: s.title, pokemon: s.pokemon, provider: s.provider, status: s.status }));
}

/** Serializes every fresh-summon call (`summonArceus` and its dev-standin
 *  sibling below) against one another. Without this, two overlapping callers
 *  — e.g. `main.tsx`'s boot-time `autoSummonArceus()` (fired but not
 *  awaited, so his rail card is already clickable while it's still in
 *  flight) racing a user's own click, or two clicks on that card in quick
 *  succession — can both pass the "arceus isn't live yet" check before
 *  either one's `addSession` lands, then both call `spawnArceus`: the second
 *  one's `existing` cleanup tears down the first's terminal/session/pty out
 *  from under it mid-flight. Queuing overlapping callers onto the SAME
 *  in-flight promise instead of letting each start its own summon closes
 *  that gap at its one shared choke point. */
let summonInFlight: Promise<void> | null = null;

function guardedSummon(run: () => Promise<void>): Promise<void> {
  if (summonInFlight) return summonInFlight;
  const p = run().finally(() => {
    if (summonInFlight === p) summonInFlight = null;
  });
  summonInFlight = p;
  return p;
}

/** Real summon — a genuine `claude` or `codex` session (provider-aware
 *  Arceus, BACKLOG item 1 — `req.provider`), spawned PLAIN. His persona is
 *  composed into his own system-prompt file at the shared `PtyManager.spawn`
 *  choke point (Arceus v2, docs/arceus-v2-plan.md §3.5 — pty.ts reads
 *  agents/arceus/SYSTEM.md fresh at spawn time), not typed as a first
 *  message — `ensureArceusSystemPrompt` is still called here first, though:
 *  it guarantees the file (seeded from the template on first-ever call) and
 *  roster.json both exist on disk before the spawn below reads them. */
export async function summonArceus(req: SummonArceusRequest): Promise<void> {
  return guardedSummon(async () => {
    const { path, prompt } = await window.api.ensureArceusSystemPrompt();
    if (!prompt.trim()) {
      throw new Error(`${path} is empty — write Arceus's instructions there and summon again.`);
    }
    const args = buildArceusArgs(req.provider, req.model, req.autoMode);
    await spawnArceus(AGENT_PROVIDERS[req.provider].defaultCommand, args, req.provider, req);
  });
}

/** Dev-only stand-in — see this file's header. Gated at the call site
 *  (SummonArceusDialog) on `config:arceusDevStandin`, not here. */
export async function summonArceusDevStandin(req: SummonArceusRequest): Promise<void> {
  return guardedSummon(async () => {
    const shell = await window.api.getDefaultShell();
    await spawnArceus(shell, [], 'shell', req);
  });
}

// ─── Summon-once (Phase 8.9) ────────────────────────────────────────────────
// "arceus should only have to be onboarded the first time" — the ORIGINAL
// summon (below, from SummonArceusDialog) stays explicit/user-initiated and
// is the only thing that WRITES agents/arceus/summon.json. Every later
// launch (main.tsx boot(), and his rail card if he's ever not live) reads
// it back and re-summons him silently. Note (BACKLOG item 3): this silent
// re-summon is only free when it resumes an existing conversation — a
// disk-persisted session at app boot (sessionRespawn.ts's `--resume`,
// main-side, never routed through `summonArceus`) or a mid-run one
// (`autoSummonArceus`'s own `tryResumeArceus`, above `autoSummonArceus`
// below) — a genuinely FRESH re-summon (nothing resumable, or a dead
// `--resume`) spawns a brand-new conversation, same as any first summon.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Continues an existing, not-currently-live Arceus conversation via
 *  `claude --resume <id>` under the same fixed `ARCEUS_SESSION_ID`, instead
 *  of starting a brand-new one — the ONLY thing that keeps a mid-run
 *  re-summon (his process exited but the app itself never restarted, so
 *  main's own boot-time `--resume` in sessionRespawn.ts never got a chance
 *  to run) from silently abandoning a resumable conversation for a fresh
 *  one that starts over with no history. `autoSummonArceus` below is the only
 *  caller, and only tries this when the not-live record it already has still
 *  carries a `claudeSessionId` (set once by hookRouter.ts's SessionStart
 *  case and never cleared).
 *
 *  Does NOT go through `spawnArceus` (that helper also tears down the
 *  STORE session record and re-adds it — right for a genuinely fresh
 *  conversation, wrong here, where the existing record just needs its
 *  status/cwd/exitCode refreshed in place). It DOES dispose and recreate
 *  the TERMINAL, though (same as `spawnArceus`) — unlike before shell
 *  fallback covered Arceus too (see pty.ts's `willFallback`), a not-live
 *  Arceus record here may have a fallback shell riding under his id right
 *  now, and that shell's exit already permanently nulled the terminal
 *  entry's parser (terminalRegistry.ts's onPtyExit — its own "nothing in
 *  this app resumes a 'done' session's CLI in place" comment stopped being
 *  true the day this became reachable with a fallback shell attached).
 *  Resuming into that entry unchanged would leave the conversation running
 *  with a dead parser forever. `hasTerminal`'s guard makes the dispose a
 *  no-op when there's nothing to tear down (a genuinely dead pty, shell
 *  fallback disabled or otherwise never spawned) — this is safe to call
 *  either way; whatever was on screen (a fallback shell's scrollback, or a
 *  truly dead session's last output) is discarded, which is correct: it's
 *  about to be replaced by a live resumed conversation, not continued. His
 *  persona is re-composed into a fresh system-prompt file by this same
 *  `--resume` spawn regardless (pty.ts's `spawn()`, keyed on his fixed id) —
 *  harmless: `--append-system-prompt-file`/`-c developer_instructions=` set
 *  the CLI's own system prompt for THIS process, they don't inject a new
 *  conversation turn, so re-applying it against an already-resumed
 *  conversation has no user-visible effect.
 *
 *  Returns whether the resume is still alive after the grace period; `false`
 *  (spawn failure, or a dead resume caught by the grace period) tells
 *  `autoSummonArceus` to fall through to a genuine fresh summon instead. */
async function tryResumeArceus(cwd: string, claudeSessionId: string): Promise<boolean> {
  // `recreateTerminal` (not a plain dispose+create): if Arceus is the
  // currently-selected session, TerminalDrawer.tsx's attach effect (keyed on
  // `[open, selectedId]` only) never re-fires for a respawn under this
  // unchanged id, so a bare dispose+create would leave the drawer's mount div
  // attached to the disposed entry and the resumed terminal blank. See
  // `recreateTerminal`'s own comment (terminalRegistry.ts) for the full
  // rationale, shared with sessions.ts's `restartSessionFresh`.
  recreateTerminal(ARCEUS_SESSION_ID, 'claude');
  const res = await window.api.spawnPty({
    id: ARCEUS_SESSION_ID,
    cwd,
    command: AGENT_PROVIDERS.claude.defaultCommand,
    args: ['--resume', claudeSessionId],
    cols: 100,
    rows: 30,
    provider: 'claude'
  });
  if (!res.ok) return false;
  // `exitCode` is cleared too — it's the PREVIOUS (dead) process's, and would
  // otherwise read as stale info about a session that hasn't exited this time.
  useStore.getState().updateSession(ARCEUS_SESSION_ID, { status: 'idle', cwd: res.cwd ?? cwd, exitCode: undefined });
  await sleep(RESUME_GRACE_MS);
  return arceusRecord()?.status !== 'done';
}

/** Summons Arceus from the saved config, picking real vs. dev-standin the
 *  same way SummonArceusDialog does. Used both at launch (main.tsx boot(),
 *  when he isn't among the restored sessions) and from his party-rail card
 *  (ArceusRosterCard.tsx, when he's saved-but-not-live). Never throws —
 *  `'failed'` covers the config's provider CLI missing from PATH, a dead
 *  `--resume` AND a failed fresh spawn, or any other spawn error; the
 *  caller turns that into a quiet toast, never a dialog.
 *
 *  Tries a mid-run `--resume` (`tryResumeArceus` above) before ever falling
 *  back to a fresh summon — the not-live record already in the store (if
 *  any) is the one source of truth for whether a resumable conversation
 *  exists, same signal main's own boot-time restore keys off, so the
 *  decision never depends on which caller (rail card or boot) reached here.
 *  Claude-only in practice: `tryResumeArceus` needs a
 *  `claudeSessionId`, which nothing else ever captures (hookRouter.ts's
 *  SessionStart case is claude-only). A codex Arceus therefore ALWAYS falls
 *  through to a genuinely fresh `summonArceus(config)` here every time this
 *  function re-summons him mid-run; sessionRespawn.ts's `shouldResume` makes
 *  the identical choice for the separate app-relaunch case (see that
 *  function's own comment). */
export async function autoSummonArceus(): Promise<AutoSummonOutcome> {
  const config = await loadArceusSummonConfig();
  if (!config) return 'no-config';
  try {
    const devStandin = await window.api.getArceusDevStandin();
    if (devStandin) {
      await summonArceusDevStandin(config);
      return 'summoned';
    }
    // Same `provider === 'claude'` guard sessionRespawn.ts's `shouldResume`
    // uses — a dev-standin record is a plain shell and would never carry a
    // `claudeSessionId` anyway, but this keeps the check exact rather than
    // relying on that being incidentally true.
    const existing = arceusRecord();
    if (
      existing?.provider === 'claude' &&
      existing.claudeSessionId &&
      (await tryResumeArceus(existing.cwd, existing.claudeSessionId))
    ) {
      return 'summoned';
    }
    await summonArceus(config);
    return 'summoned';
  } catch (err) {
    console.error('[arceus] auto-summon failed:', err);
    // Already toasted to the user (main.tsx's boot()) but that's UI-only —
    // this is what makes "arceus won't come back" traceable in harness.log
    // (BACKLOG friend-testing readiness).
    safeLogDiagnostic('arceus', 'error', 'auto-summon failed', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return 'failed';
  }
}

/** Arceus v2 (docs/arceus-v2-plan.md §3.2/§7) — subscribes once to
 *  `poke-ask` requests main pushes (main/index.ts's `onPokeAsk`) and stores
 *  each one so PokeAskModal.tsx renders it. Call once, from main.tsx's
 *  boot(), same as sessions.ts's `startPokeSpawnListener`/
 *  `startPokeRelayDeliveredListener`. */
export function startPokeAskListener(): void {
  window.api.onPokeAsk((notice) => {
    useStore.getState().setPokeAsk(notice);
  });
}

