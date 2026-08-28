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
 * rule). `summonArceus` is the real path (a genuine `claude` with
 * agents/arceus/SYSTEM.md appended); `summonArceusDevStandin` swaps that for
 * a plain shell tagged `isArceus`, gated by main's `config:arceusDevStandin`
 * (POKE_ARCEUS_DEV_STANDIN=1) — see the dialog, which picks between them.
 * Everything but the real claude spawn (the cosmos ascent, alpha card,
 * dispatch box, persistence, cross-workspace presence) is exercisable
 * through the stand-in.
 */
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import {
  ARCEUS_DEX_ID,
  ARCEUS_SESSION_ID,
  ARCEUS_TITLE,
  buildArceusArgs,
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

/** Real summon — a genuine `claude` session with agents/arceus/SYSTEM.md's
 *  CURRENT contents appended (re-read fresh here every call; see
 *  main/arceusPrompt.ts). */
export async function summonArceus(req: SummonArceusRequest): Promise<void> {
  const { path, prompt } = await window.api.ensureArceusSystemPrompt();
  if (!prompt.trim()) {
    throw new Error(`${path} is empty — write Arceus's instructions there and summon again.`);
  }
  const args = buildArceusArgs(req.model, req.autoMode, prompt);
  await spawnArceus(AGENT_PROVIDERS.claude.defaultCommand, args, 'claude', req);
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
// it back and re-summons him silently: an idle interactive `claude` session
// consumes no tokens until prompted, so auto-summoning at launch (or on a
// chip click that finds him gone) is cost-safe — nothing here spends money
// just by existing.
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
