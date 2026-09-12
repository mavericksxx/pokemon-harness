/**
 * Arceus v2 (docs/arceus-v2-plan.md §3.2/§3.4/§7) — main-side support for
 * `poke-relay` (target/workspace resolution + the idle-safety delivery
 * queue). `poke-ask`/`poke-spawn` need no equivalent module of their own:
 * `poke-ask` is a one-line push to the renderer (main/index.ts's own
 * `onPokeAsk` callback), and `poke-spawn` reuses `ptyManager.spawn` directly
 * the same way `onDelegateSpawnRequest` already does — neither needs a
 * stateful helper class the way relay's idle-queue does.
 *
 * Replaces `main/arceusRelay.ts`'s `ArceusRelayWatcher` entirely — that
 * class discovered a relay directive by tailing Arceus's own transcript for
 * an `@@relay` text line; `poke-relay` is a real tool call instead, so there
 * is nothing left to poll or tail. Only the delivery half survives
 * (`InjectionQueue` — shared/injectionQueue.ts), unchanged.
 */
import { InjectionQueue } from '../shared/injectionQueue';
import type { PtyResult, SessionRecord } from '../shared/types';
import type { WorkspaceRecord } from '../shared/workspaceTypes';

/** Per-target cap on queued-while-busy relays — same value/reasoning
 *  ArceusRelayWatcher used (a chatty Arceus relaying repeatedly to one stuck
 *  session can't grow this without bound; oldest drops first). */
const MAX_QUEUE_PER_TARGET = 20;

/** Sensible cap on one relayed message, mirroring ArceusRelayWatcher's own
 *  `MAX_MESSAGE_LEN` — generous for a real instruction, small enough to stop
 *  a pathological wall of text from getting typed into someone's terminal. */
const MAX_MESSAGE_LEN = 4_000;

/** Pure — resolves a `poke-relay`/`poke-spawn` workspace hint against the
 *  live registry: exact id match first, then a case-insensitive exact name
 *  match, then a case-insensitive substring name match. Returns null (never
 *  a silent default) on no match — sending a task to the WRONG project
 *  silently would be worse than Arceus having to retry with a name copied
 *  straight from roster.json's own workspaces block. */
export function resolveWorkspaceHint(hint: string, workspaces: WorkspaceRecord[]): WorkspaceRecord | null {
  const needle = hint.trim().toLowerCase();
  if (!needle) return null;
  const byId = workspaces.find((w) => w.id === hint.trim());
  if (byId) return byId;
  const byExactName = workspaces.find((w) => w.name.trim().toLowerCase() === needle);
  if (byExactName) return byExactName;
  const bySubstring = workspaces.filter((w) => w.name.toLowerCase().includes(needle));
  return bySubstring.length === 1 ? bySubstring[0] : null;
}

/** Pure — resolves a `poke-relay` `agent` hint against the live, non-Arceus
 *  roster: exact session id, then case-insensitive session title, then (if
 *  unambiguous) pokémon species — the same three-tier resolution the
 *  deleted `@@relay` directive used (`resolveRelayTarget`, formerly in
 *  main/arceusRelay.ts). A 'done' session is excluded — its pty is already
 *  dead. */
export function resolvePokeRelayTarget(name: string, sessions: SessionRecord[]): SessionRecord | null {
  const trimmed = name.trim();
  const needle = trimmed.toLowerCase();
  if (!needle) return null;
  const candidates = sessions.filter((s) => !s.isArceus && !s.isPlainTerminal && s.status !== 'done');

  const byId = candidates.find((s) => s.id === trimmed);
  if (byId) return byId;

  const byTitle = candidates.find((s) => s.title.trim().toLowerCase() === needle);
  if (byTitle) return byTitle;

  const bySpecies = candidates.filter((s) => s.pokemon.toLowerCase() === needle);
  return bySpecies.length === 1 ? bySpecies[0] : null;
}

/** `poke-relay`'s delivery half — resolves the named target and submits the
 *  message to the same idle-safety `InjectionQueue` ArceusRelayWatcher used
 *  (never type into a non-idle session; queue and deliver the moment it next
 *  goes idle). Fire-and-return-immediately (docs/arceus-v2-plan.md §3.2):
 *  `submit` only reports whether the request was ACCEPTED (a valid target
 *  resolved), never waits for the actual delivery — `onDelivered` fires
 *  later, independently, once the message is actually typed in. */
export class PokeRelay {
  private queue: InjectionQueue<string>;

  constructor(
    writePty: (id: string, data: string) => PtyResult,
    private getSessions: () => SessionRecord[],
    /** Fired once a queued/immediate message is actually written into the
     *  target's pty (write may still have failed — see the boolean) — main
     *  process has no store to stamp `lastDispatch` on directly (that's the
     *  renderer's, mirrored back via `sessions:checkpoint`), so this pushes
     *  a one-way notice for the renderer to stamp its own copy. */
    private onDelivered: (targetId: string, message: string, at: number, ok: boolean) => void
  ) {
    this.queue = new InjectionQueue<string>(writePty, MAX_QUEUE_PER_TARGET, (m) => `${m}\r`, {
      onDeliver: (target, item, res) => this.onDelivered(target.id, item, Date.now(), res.ok)
    });
  }

  /** Resolves `agentHint` and queues/sends `message` — returns whether a
   *  target was found (accepted), not whether it's actually been typed yet.
   *  `queued: true` (advisor follow-up) tells the caller the target wasn't
   *  idle at submit time, so its own ack/note can say "queued" rather than
   *  implying immediate delivery — a relay to a busy agent can otherwise sit
   *  silently for minutes while `poke-relay`'s own CLI output claimed
   *  success. */
  submit(agentHint: string, message: string): { ok: boolean; error?: string; queued?: boolean } {
    const target = resolvePokeRelayTarget(agentHint, this.getSessions());
    if (!target) return { ok: false, error: `no such agent: ${agentHint}` };
    const trimmed = message.trim().slice(0, MAX_MESSAGE_LEN);
    if (!trimmed) return { ok: false, error: 'a message is required' };
    const result = this.queue.submit(target, trimmed);
    return { ok: true, queued: result === 'queued' };
  }

  /** Call on every session-list checkpoint (main/ipc/sessions.ts) — flushes
   *  any relay queued for a target that's now idle, or drops it if the
   *  target closed/finished in the meantime. */
  onSessionsChecked(sessions: SessionRecord[]): void {
    this.queue.flush(sessions);
  }
}
