/**
 * In-app demo mode — a mock-session layer that drives the REAL garden scene,
 * roster strip, terminal drawer, and Arceus warp with fake sessions and
 * scripted events, no real pty involved. Mirrors the shape of `sessions.ts`/
 * `arceus.ts`: this module owns spawning/teardown, DemoConsole.tsx is the
 * trigger UI.
 *
 * A demo session is an ordinary `SessionRecord` in the store — GardenScene,
 * the roster strip, and the terminal drawer never need to know it's fake.
 * The ONE thing that marks a session as demo lives entirely here, in-memory,
 * never on `SessionRecord` itself (so a demo session is structurally
 * incapable of surviving a checkpoint/restore): `demoIds`, guarded by
 * `isDemoSession` at every real-IO call site (writePty/resizePty/killPty —
 * see terminalRegistry.ts, sessions.ts, ArceusDispatchBox.tsx) and at the
 * checkpoint subscriber (sessions.ts's `startRegistrySync`).
 */
import { useSyncExternalStore } from 'react';
import { ARCEUS_DEX_ID, ARCEUS_SESSION_ID, ARCEUS_TITLE } from '@shared/arceus';
import { useStore } from '@/store/store';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { createTerminal, disposeTerminal, hasTerminal, writeReplayNow } from '@/pty/terminalRegistry';
import { pickFreeLine } from '@/scene/garden/showdownArt';
import { speciesEntry } from '@/scene/garden/dexData';
import { evolutionConfig } from '@/scene/garden/evolution';
import { stationForTool } from '@/scene/garden/stations';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';
import { emitClosingRitualSignal } from '@/scene/garden/closingRitualBus';
import { emitCharmSignal } from '@/scene/garden/charmBus';
import { arceusIsLive } from '@/arceus';

// ─── demo-session identity (in-memory only) ────────────────────────────────

const demoIds = new Set<string>();

export const isDemoSession = (id: string): boolean => demoIds.has(id);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tiny observable value, same shape as the rest of this app's hand-rolled
 *  subscribe/getSnapshot pairs (e.g. closingTime.ts's `running`) but exposed
 *  reactively via `useSyncExternalStore` so DemoConsole.tsx can react without
 *  a full zustand slice for two booleans. */
function makeAtom<T>(initial: T): { get: () => T; set: (v: T) => void; subscribe: (cb: () => void) => () => void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      if (v === value) return;
      value = v;
      for (const l of listeners) l();
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
}

const activeAtom = makeAtom(false);
const showreelAtom = makeAtom(false);
const consoleOpenAtom = makeAtom(false);

export function useDemoActive(): boolean {
  return useSyncExternalStore(activeAtom.subscribe, activeAtom.get);
}

export function useShowreelRunning(): boolean {
  return useSyncExternalStore(showreelAtom.subscribe, showreelAtom.get);
}

/** DemoConsole.tsx's popover open/closed — a hook rather than local
 *  component state so App.tsx's existing global ⌘D keydown handler can
 *  toggle it without owning (or lifting) the component's state itself. */
export function useDemoConsoleOpen(): boolean {
  return useSyncExternalStore(consoleOpenAtom.subscribe, consoleOpenAtom.get);
}

export function toggleDemoConsole(): void {
  if (!activeAtom.get()) return;
  consoleOpenAtom.set(!consoleOpenAtom.get());
}

export function closeDemoConsole(): void {
  consoleOpenAtom.set(false);
}

export function enterDemo(): void {
  activeAtom.set(true);
}

export function exitDemo(): void {
  closeDemoConsole();
  if (!activeAtom.get()) return;
  cancelShowreel();
  const ids = [...demoIds];
  const wasSelectedDemo = ids.includes(useStore.getState().selectedId ?? '');
  for (const id of ids) {
    for (const b of useStore.getState().battlers) {
      if (b.parentId === id) useStore.getState().requestDespawnBattler(b.key);
    }
    if (hasTerminal(id)) disposeTerminal(id);
    useStore.getState().removeSession(id);
  }
  demoIds.clear();
  if (wasSelectedDemo) useStore.getState().select(null);
  activeAtom.set(false);
}

// ─── scripted terminal transcript ──────────────────────────────────────────

/** Typewriter-style replay feed (terminalRegistry.ts's `writeReplayNow`),
 *  chunked rather than written in one shot so it reads as live output rather
 *  than a paste. Bails as soon as `id` stops being a demo session (torn down
 *  mid-type by `exitDemo`/`recall`) rather than writing into a disposed
 *  terminal. Chrome voice: lowercase, no emoji. */
async function typeLines(id: string, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 3) {
      if (!demoIds.has(id)) return;
      writeReplayNow(id, line.slice(i, i + 3));
      await sleep(12);
    }
    if (!demoIds.has(id)) return;
    writeReplayNow(id, '\r\n');
  }
}

// ─── session spawn/lookup helpers ──────────────────────────────────────────

function newDemoId(): string {
  return `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Shared by `spawn`/`shiny`/`mega` — mirrors sessions.ts's `startSession`
 *  (58-93) minus the `spawnPty`/`initShinyConfig` calls a fake session has no
 *  use for: create the terminal first (so the drawer has something to attach
 *  to the instant it's selected), add the store entry, then flip it idle the
 *  same way a real spawn's resolved `spawnPty` does. `pokemon`/`line` are
 *  passed in explicit (rather than resolved here) so `mega` can hand this an
 *  exact evolved species instead of the base-stage normalization an ordinary
 *  spawn always applies. */
function addDemoSession(pokemon: string, line: string, shiny: boolean, select = true): string {
  const id = newDemoId();
  createTerminal(id, 'shell');
  useStore.getState().addSession(
    {
      id,
      title: speciesEntry(pokemon)?.name ?? pokemon,
      cwd: 'demo',
      command: 'demo',
      provider: 'shell',
      pokemon,
      line,
      shiny,
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId
    },
    { select }
  );
  demoIds.add(id);
  useStore.getState().updateSession(id, { status: 'idle' });
  void typeLines(id, ['$ demo session started', '> ready.']);
  return id;
}

/** The currently selected session, but only if it's one of ours — every
 *  trigger that acts on "the selected session" funnels through this so a
 *  stray click on a real session can't be mutated by a demo button. */
function selectedDemoId(): string | null {
  const id = useStore.getState().selectedId;
  if (!id || !isDemoSession(id)) {
    useStore.getState().pushToast('select a demo session first');
    return null;
  }
  return id;
}

function beat(id: string): void {
  useStore.getState().updateSession(id, { napping: false });
}

// ─── triggers ───────────────────────────────────────────────────────────────

export function spawn(): string {
  if (!activeAtom.get()) return '';
  const picked = pickFreeLine(useStore.getState().takenLines());
  return addDemoSession(picked.name, picked.line, false);
}

export function shiny(): string {
  if (!activeAtom.get()) return '';
  const picked = pickFreeLine(useStore.getState().takenLines());
  return addDemoSession(picked.name, picked.line, true);
}

/** Read/Edit/Bash/Grep, cycled per session rather than random, so repeated
 *  clicks visibly move through a plausible sequence of tool calls. */
const TOOL_CYCLE: readonly { tool: string; target: string }[] = [
  { tool: 'Read', target: 'src/index.ts' },
  { tool: 'Edit', target: 'src/index.ts' },
  { tool: 'Bash', target: 'npm test' },
  { tool: 'Grep', target: 'TODO' }
];
const toolCycleIndex = new Map<string, number>();

export function toolCall(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  const i = (toolCycleIndex.get(id) ?? 0) % TOOL_CYCLE.length;
  toolCycleIndex.set(id, i + 1);
  const { tool, target } = TOOL_CYCLE[i];
  useStore.getState().updateSession(id, { status: 'working', tool, toolTarget: target, station: stationForTool(tool) });
  void typeLines(id, [`> ${tool.toLowerCase()} ${target}`, '  done.']);
}

export function thinking(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  useStore.getState().updateSession(id, { status: 'working', tool: undefined, toolTarget: undefined });
  void typeLines(id, ['> thinking…']);
}

/** hookRouter.ts:324's `Stop` patch. */
export function idle(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  useStore.getState().updateSession(id, { status: 'idle', tool: undefined, toolTarget: undefined, station: 'wander' });
  void typeLines(id, ['> idle.']);
}

/** hookRouter.ts:422's "needs you" patch. */
export function needsYou(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  useStore.getState().updateSession(id, { status: 'blocked', station: 'signpost' });
  void typeLines(id, ['> waiting for your input…']);
}

/** terminalRegistry.ts:270-276's PtyExit patch. */
export function done(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  useStore.getState().updateSession(id, { status: 'done', exitCode: 0, tool: undefined, toolTarget: undefined, station: 'wander' });
  void typeLines(id, ['\x1b[90m[process exited with code 0]\x1b[0m']);
}

export function nap(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  const s = useStore.getState().sessions.find((x) => x.id === id);
  useStore.getState().updateSession(id, { napping: !s?.napping });
}

export function looping(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  const s = useStore.getState().sessions.find((x) => x.id === id);
  useStore.getState().updateSession(id, { looping: !s?.looping });
}

export function smallTalk(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  emitCharmSignal({ type: 'chatter', sessionId: id });
}

export function berry(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  beat(id);
  emitCharmSignal({ type: 'berry', sessionId: id });
}

// ─── subagent battle ────────────────────────────────────────────────────────

let lastSubagentParentId: string | null = null;
let lastSubagentToolUseId: string | null = null;

/** Shared by the `subagent` trigger and `mega` (which targets a session it
 *  just spawned rather than whatever's currently selected). Mirrors a real
 *  `Task` PreToolUse's own spawn->correlate pairing (hookRouter.ts:286-291,
 *  132-138) — the correlate call is what lets `subagentDone` retire this
 *  EXACT battler later regardless of `MIN_ROAM_MS` (BattleManager.ts's
 *  own comment on `handleEnd` bypassing it for a correlated taskId). */
function spawnSubagentFor(parentId: string): void {
  const toolUseId = `demo-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  emitBattleSignal({ type: 'spawn', parentId, label: 'demo subagent', toolUseId });
  emitBattleSignal({ type: 'correlate', parentId, toolUseId, taskId: toolUseId });
  lastSubagentParentId = parentId;
  lastSubagentToolUseId = toolUseId;
}

/** Parent must be a non-Arceus, non-plain-terminal demo session already
 *  reconciled into a garden walker — an id selected straight off a just-
 *  spawned session (same tick) has no walker yet; callers that chain off
 *  `spawn`/`shiny` should give it ~300ms first (see `showreel`/`mega`). */
export function subagent(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  const parent = useStore.getState().sessions.find((s) => s.id === id);
  if (!parent || parent.isArceus || parent.isPlainTerminal) {
    useStore.getState().pushToast('pick a non-arceus, non-terminal demo session first');
    return;
  }
  spawnSubagentFor(id);
}

export function subagentDone(): void {
  if (!activeAtom.get()) return;
  if (!lastSubagentParentId || !lastSubagentToolUseId) {
    useStore.getState().pushToast('no demo subagent to complete');
    return;
  }
  emitBattleSignal({ type: 'end', parentId: lastSubagentParentId, taskId: lastSubagentToolUseId });
}

/** Spawns a demo session whose species is a MEGA_FORMS key, then runs a
 *  subagent battle for it — BattleManager fires the mega beat itself once
 *  the fight reaches faceoff (megaForms.ts's own header). `charizard` is
 *  hardcoded (rather than picked from MEGA_FORMS, which isn't exported —
 *  see that file's header for why the table is deliberately incomplete
 *  coverage) since it's both a MEGA_FORMS key and one of the 42 bundled
 *  species, so this never needs a lazy-sprite fetch. */
export function mega(): void {
  if (!activeAtom.get()) return;
  const line = speciesEntry('charizard')?.line ?? 'charizard';
  const id = addDemoSession('charizard', line, false);
  void (async () => {
    await sleep(300); // let GardenScene reconcile this session into a walker
    if (!demoIds.has(id)) return;
    useStore.getState().select(id);
    spawnSubagentFor(id);
    await sleep(2500); // one battle wave (BattleManager.ts's own ~2s beat)
    if (!demoIds.has(id) || lastSubagentParentId !== id) return;
    subagentDone();
  })();
}

/** hookRouter.ts's Stop->working->workedMs flow, but sequenced by hand:
 *  GardenScene.tsx's 1Hz evolution check only ever reads a session whose
 *  Runtime accumulated NEW work since the last flush (`rt.workAccumMs > 0`,
 *  itself only incremented while `rt.status === 'working'` — see that
 *  file's own comment above the threshold check), so `workedMs` must be set
 *  AFTER `status` flips to 'working', not before — otherwise the very next
 *  1Hz tick sees `workAccumMs` still at 0 and skips the session outright. */
export function evolve(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  const session = useStore.getState().sessions.find((s) => s.id === id);
  if (!session) return;
  const entry = speciesEntry(session.pokemon);
  if (!entry || entry.evolvesTo.length === 0) {
    useStore.getState().pushToast(`${session.title} has nothing left to evolve into`);
    return;
  }
  const { stage2Ms, stage3Ms } = evolutionConfig();
  const threshold = entry.stage === 1 ? stage2Ms : stage3Ms;
  useStore.getState().updateSession(id, { status: 'working' });
  useStore.getState().updateSession(id, { workedMs: threshold });
}

/** Reuses the app's own done-delegate pokéball recall (AgentRosterCard.tsx's
 *  despawn button / GardenScene.tsx's `recallDelegate`) rather than building
 *  a second removal animation: stamping a (nonexistent) `delegateParentId`
 *  on a done demo session makes it match that exact same
 *  `delegateParentId && status === 'done'` condition, so
 *  `requestRecallDelegate` drives the identical walker.startRecall ->
 *  stopSession teardown a real finished delegate gets. `stopSession` itself
 *  is guarded (sessions.ts) to skip `killPty` for a demo id, so nothing here
 *  ever touches a real pty. */
export function recall(): void {
  if (!activeAtom.get()) return;
  const id = selectedDemoId();
  if (!id) return;
  const session = useStore.getState().sessions.find((s) => s.id === id);
  if (!session || session.status !== 'done') {
    useStore.getState().pushToast('recall only works on a done session');
    return;
  }
  useStore.getState().updateSession(id, { delegateParentId: session.delegateParentId ?? 'demo-recall' });
  useStore.getState().requestRecallDelegate(id);
}

// ─── arceus ─────────────────────────────────────────────────────────────────

const ARCEUS_TRANSCRIPT: readonly string[] = [
  '> arceus online.',
  'garden roster synced — standing by for a task.'
];

export function arceus(): void {
  if (!activeAtom.get()) return;
  if (isDemoSession(ARCEUS_SESSION_ID)) {
    useStore.getState().select(ARCEUS_SESSION_ID);
    return;
  }
  if (arceusIsLive()) {
    useStore.getState().pushToast('real arceus is live');
    return;
  }
  createTerminal(ARCEUS_SESSION_ID, 'shell');
  useStore.getState().addSession({
    id: ARCEUS_SESSION_ID,
    title: ARCEUS_TITLE,
    cwd: 'demo',
    command: 'demo',
    provider: 'shell',
    pokemon: ARCEUS_DEX_ID,
    line: ARCEUS_DEX_ID,
    shiny: false,
    isArceus: true
  });
  demoIds.add(ARCEUS_SESSION_ID);
  useStore.getState().updateSession(ARCEUS_SESSION_ID, { status: 'idle' });
  useStore.getState().select(ARCEUS_SESSION_ID);
  void typeLines(ARCEUS_SESSION_ID, ARCEUS_TRANSCRIPT);
}

/** ArceusDispatchBox.tsx's demo-Arceus branch — echoes the dispatched text
 *  and a canned reply into his terminal instead of writing a real pty. */
export function echoArceusDispatch(text: string): void {
  if (!activeAtom.get()) return;
  writeReplayNow(ARCEUS_SESSION_ID, `\r\n> ${text}\r\n`);
  writeReplayNow(ARCEUS_SESSION_ID, 'on it — dispatching now.\r\n');
}

// ─── closing ritual / toast ─────────────────────────────────────────────────

/** Fires the ritual signal directly — NEVER `startClosingTime()`
 *  (closingTime.ts), which quits the app on completion. */
export function closingRitual(): void {
  if (!activeAtom.get()) return;
  emitClosingRitualSignal({ type: 'start' });
}

/** A couple of the app's own real toast texts (sessions.ts:314, and the
 *  looping-session "steer" offer store.ts's `Toast.action` doc comment
 *  describes) rather than an invented demo-only string. */
export function toast(): void {
  if (!activeAtom.get()) return;
  useStore.getState().pushToast('demo agent finished.');
  useStore.getState().pushToast('demo agent is looping — want to steer it?', {
    label: 'steer',
    onClick: () => {}
  });
}

// ─── showreel ───────────────────────────────────────────────────────────────

let showreelAbort = false;

/** Aborts between beats AND during any in-beat wait (checked every 200ms) —
 *  more responsive than the "between beats" minimum, since a beat's own wait
 *  can run up to ~15s (the closing ritual). */
async function sleepAbortable(ms: number): Promise<void> {
  const step = 200;
  let remaining = ms;
  while (remaining > 0 && !showreelAbort) {
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
}

export function cancelShowreel(): void {
  showreelAbort = true;
}

/** Hands-free tour through every beat this module drives, spawning its own
 *  2-3 sessions and selecting as it goes (so the drawer's transcript always
 *  matches whatever the reel is narrating) — beat order/shape lifted from
 *  tools/demo/template.html's own `REEL` (1101-1114), minus that standalone
 *  demo's session-vs-session battle (this app has no such mechanic — see the
 *  brief). Durations: evolution's ceremony runs ~8.7s real time
 *  (`DECAY_END * durationScale`, evolution.ts's default 0.6 scale); a battle
 *  wave is ~2s plus BattleManager's own 4-6s inter-wave cooldown; the closing
 *  ritual caps at 15s (ClosingRitual.ts). */
export async function showreel(): Promise<void> {
  if (showreelAtom.get()) {
    cancelShowreel();
    return;
  }
  if (!activeAtom.get()) return;
  showreelAbort = false;
  showreelAtom.set(true);
  try {
    let a = '';
    let b = '';

    const beats: Array<() => Promise<void>> = [
      async () => {
        a = spawn();
        await sleepAbortable(2500);
      },
      async () => {
        thinking();
        await sleepAbortable(1500);
        for (let i = 0; i < TOOL_CYCLE.length; i++) {
          toolCall();
          await sleepAbortable(1600);
        }
      },
      async () => {
        idle();
        await sleepAbortable(1000);
        smallTalk();
        await sleepAbortable(2200);
      },
      async () => {
        b = shiny();
        await sleepAbortable(2500);
        toolCall();
        await sleepAbortable(1500);
      },
      async () => {
        useStore.getState().select(a);
        needsYou();
        await sleepAbortable(2600);
        idle();
        toolCall();
        await sleepAbortable(1600);
      },
      async () => {
        useStore.getState().select(a);
        toolCall();
        await sleepAbortable(800);
        subagent();
        await sleepAbortable(2500); // one battle wave
        subagentDone();
        await sleepAbortable(5000); // BattleManager's own inter-wave cooldown
      },
      async () => {
        useStore.getState().select(a);
        toolCall();
        await sleepAbortable(600);
        evolve();
        await sleepAbortable(8700);
      },
      async () => {
        useStore.getState().select(b);
        nap();
        await sleepAbortable(2400);
        nap();
        toolCall();
        await sleepAbortable(1400);
      },
      async () => {
        useStore.getState().select(b);
        idle();
        await sleepAbortable(500);
        berry();
        await sleepAbortable(1800);
      },
      async () => {
        closingRitual();
        await sleepAbortable(15000);
      },
      async () => {
        useStore.getState().select(a);
        done();
        await sleepAbortable(1200);
        recall();
        await sleepAbortable(1500);
      }
    ];

    for (const step of beats) {
      if (showreelAbort) break;
      await step();
    }
  } finally {
    showreelAtom.set(false);
  }
}
