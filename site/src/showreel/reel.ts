/**
 * The showreel's director: a looping script that plays a few sessions
 * through the app's headline features inside a replica app window.
 *
 * Real:
 *   - the window's chrome: the app's own RosterStrip (Agent/Subagent/Arceus
 *     roster cards), TerminalDrawer (real xterm via terminalRegistry, fed
 *     through the shimmed pty channel), SessionStatusStrip, topbar controls,
 *     DayNightToggle, ArceusWarp and ArceusHud, all reading the app's real
 *     zustand stores, styled by the app's own index.css (see ReelApp.tsx);
 *   - the garden (garden.ts): map, walkers, tool bubbles, spawn beat, wild
 *     battlers and battles (BattleManager fed through battleBus exactly like
 *     hookRouter does), evolution ceremony, shiny reveal, mega ceremony,
 *     day/night overlay.
 * Scripted: which sessions exist and what they do, the transcript text,
 * cost/context numbers, and the timing.
 *
 * Everything runs on one clock advanced by the Pixi ticker, so pausing the
 * ticker (off-screen, hidden tab) pauses the whole reel in lockstep.
 */
import { feedPty } from './apiShim';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';
import { POKEMON_ROSTER } from '@/scene/garden/showdownArt';
import { speciesEntry } from '@/scene/garden/dexData';
import { useStore, type Session } from '@/store/store';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useUsageStore } from '@/store/usageStore';
import { createTerminal, disposeTerminal } from '@/pty/terminalRegistry';
import { ARCEUS_SESSION_ID, ARCEUS_TITLE } from '@shared/arceus';
import { DEFAULT_WORKSPACE_ID } from '@shared/workspaceTypes';
import type { SessionStatus } from '@shared/types';
import { mountReelWindow } from './ReelApp';
import { mountShowreel, type ReelGarden } from './garden';

export interface ReelElements {
  stage: HTMLElement;
  window: HTMLElement;
  caption: HTMLElement;
}

export interface ReelController {
  setPaused(paused: boolean): void;
  destroy(): void;
}

/** Thrown into a pending wait when the reel is destroyed, unwinding the script. */
class Stopped extends Error {}

const BUNDLED_LINES = [...new Set(POKEMON_ROSTER.map((p) => p.line))];
/** Every bundled line but `keep`: BattleManager's own species picker (fed
 *  through its injectable `activeSessionLines`) then has exactly one
 *  eligible bundled base form left, so the wild battler is deterministic. */
const onlyLine = (keep: string): string[] => BUNDLED_LINES.filter((l) => l !== keep);

// ── transcript formatting (Claude Code's own look, as ANSI) ──────────────────
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const ORANGE = '\x1b[38;5;173m';
const GREY = '\x1b[90m';
const NL = '\r\n';

function seedStores(): void {
  useWorkspaceStore.setState({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'pokeharness', primaryFolder: '~/Developer', createdAt: 0 }],
    activeWorkspaceId: DEFAULT_WORKSPACE_ID
  });
  useAppSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      theme: 'dark',
      usageLimitsEnabled: true,
      mainUsageProvider: 'claude',
      dayNightMode: 'auto',
      onboardingDone: true
    }
  }));
  const hour = 3_600_000;
  useUsageStore.getState().hydrate({
    enabled: true,
    updatedAt: Date.now(),
    providers: [
      {
        provider: 'claude',
        state: 'ok',
        updatedAt: Date.now(),
        windows: [
          { label: '5h', usedPercent: 6, resetsAt: Date.now() + 4 * hour },
          { label: '7d', usedPercent: 48, resetsAt: Date.now() + 70 * hour },
          { label: '7d fable', usedPercent: 29, resetsAt: Date.now() + 70 * hour }
        ]
      }
    ]
  });
  useStore.setState({
    sessions: [],
    battlers: [],
    selectedId: null,
    viewMode: 'garden',
    drawerOpen: true,
    narrowLayout: false,
    railCollapsed: false,
    gardenSplit: 0.6,
    collapsedParentIds: [],
    arceusExchange: []
  });
}

export async function startReel(els: ReelElements): Promise<ReelController> {
  seedStores();
  const win = mountReelWindow(els.window);
  const garden: ReelGarden = await mountShowreel(win.gardenHost, 0x17171b);

  // --- clock ---------------------------------------------------------------
  let now = 0;
  let stopped = false;
  const timers: { at: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const waits: { pred: () => boolean; deadline: number; resolve: (ok: boolean) => void; reject: (e: Error) => void }[] = [];
  let keepAliveMs = 0;
  garden.onTick((dt) => {
    now += dt;
    // Plain-shell terminals nap after 30s without pty output (terminalRegistry's
    // nap watch); an empty write counts as output without drawing anything.
    keepAliveMs += dt;
    if (keepAliveMs > 8000) {
      keepAliveMs = 0;
      for (const s of useStore.getState().sessions) feedPty(s.id, '');
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].at <= now) timers.splice(i, 1)[0].resolve();
    }
    for (let i = waits.length - 1; i >= 0; i--) {
      const w = waits[i];
      const ok = w.pred();
      if (ok || now >= w.deadline) waits.splice(i, 1)[0].resolve(ok);
    }
  });
  const wait = (ms: number): Promise<void> =>
    stopped ? Promise.reject(new Stopped()) : new Promise((resolve, reject) => timers.push({ at: now + ms, resolve, reject }));
  const until = (pred: () => boolean, timeoutMs: number): Promise<boolean> =>
    stopped
      ? Promise.reject(new Stopped())
      : new Promise((resolve, reject) => waits.push({ pred, deadline: now + timeoutMs, resolve, reject }));

  // --- battler presence -> the real store (as GardenScene does) ---------------
  let lastBattlerKey: string | null = null;
  const doneKeys = new Set<string>();
  const onBattler = (e: Event): void => {
    const d = (e as CustomEvent).detail as {
      event: 'spawn' | 'remove' | 'done';
      key: string;
      parentId?: string;
      species?: string;
      label?: string;
      done?: boolean;
    };
    const store = useStore.getState();
    if (d.event === 'spawn') {
      lastBattlerKey = d.key;
      store.addBattler({ key: d.key, parentId: d.parentId!, species: d.species!, label: d.label });
    } else if (d.event === 'done') {
      if (d.done) doneKeys.add(d.key);
      store.setBattlerDone(d.key, !!d.done);
    } else {
      store.removeBattler(d.key);
    }
  };
  window.addEventListener('reel:battler', onBattler);

  // --- helpers --------------------------------------------------------------
  const caption = (text: string): void => {
    els.caption.textContent = text;
  };

  const update = (id: string, patch: Partial<Session>): void => useStore.getState().updateSession(id, patch);

  const spawn = (id: string, title: string, pokemon: string, opts: { shiny?: boolean; model?: string; cwd?: string } = {}): void => {
    const entry = speciesEntry(pokemon);
    const s = useStore.getState().addSession(
      {
        id,
        title,
        cwd: opts.cwd ?? `~/Developer/${title.replace(/-dev$|-main$/, '')}`,
        command: 'claude',
        provider: 'claude',
        model: opts.model ?? 'claude-opus-5',
        pokemon,
        line: entry?.line ?? pokemon,
        shiny: !!opts.shiny,
        workspaceId: DEFAULT_WORKSPACE_ID
      },
      { select: true }
    );
    createTerminal(id, 'shell');
    garden.upsert({ id, title, pokemon, shiny: !!opts.shiny, status: 'starting', accent: s.accent });
  };

  const status = (id: string, st: SessionStatus): void => {
    const patch: Partial<Session> = { status: st, statusChangedAt: Date.now() };
    if (st !== 'working') Object.assign(patch, { tool: undefined, toolTarget: undefined });
    update(id, patch);
    garden.patch(id, { status: st, ...(st === 'working' ? {} : { tool: undefined, toolTarget: undefined }) });
  };

  /** Adds spend to a session's cost telemetry (what costWatcher pushes in the app). */
  const spend = (id: string, dollars: number, tokens: number): void => {
    const s = useStore.getState().sessions.find((x) => x.id === id);
    if (!s) return;
    const c = s.cost ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, contextTokens: 0, contextWindow: 1_000_000, model: s.model ?? null };
    update(id, {
      cost: {
        ...c,
        inputTokens: c.inputTokens + Math.round(tokens * 0.8),
        outputTokens: c.outputTokens + Math.round(tokens * 0.2),
        costUsd: c.costUsd + dollars,
        contextTokens: c.contextTokens + tokens
      }
    });
  };

  const type = async (id: string, text: string, perCharMs = 30): Promise<void> => {
    for (const ch of text) {
      feedPty(id, ch);
      await wait(ch === ' ' ? perCharMs * 0.6 : perCharMs);
    }
    feedPty(id, NL);
  };

  const banner = (id: string, cwd: string): void => {
    const inner = 46;
    const pad = (t: string, visible: number): string => t + ' '.repeat(Math.max(0, inner - visible));
    feedPty(
      id,
      `${ORANGE}╭${'─'.repeat(inner + 2)}╮${RESET}${NL}` +
        `${ORANGE}│${RESET} ${pad(`${ORANGE}✻${RESET} Welcome to ${BOLD}Claude Code${RESET}!`, 25)} ${ORANGE}│${RESET}${NL}` +
        `${ORANGE}│${RESET} ${pad('', 0)} ${ORANGE}│${RESET}${NL}` +
        `${ORANGE}│${RESET} ${pad(`${GREY}  cwd: ${cwd}${RESET}`, 7 + cwd.length)} ${ORANGE}│${RESET}${NL}` +
        `${ORANGE}╰${'─'.repeat(inner + 2)}╯${RESET}${NL}${NL}`
    );
  };

  const prompt = async (id: string, text: string): Promise<void> => {
    feedPty(id, `${DIM}>${RESET} `);
    await type(id, text, 24);
    feedPty(id, NL);
  };

  /** One tool call: store tool/target (roster tool line + status strip), walker
   *  bubble, spend, and the transcript's `⏺ Tool(target)` + `⎿ result`. */
  const toolCall = async (id: string, tool: string, target: string, result: string, cost: [number, number]): Promise<void> => {
    update(id, { status: 'working', tool, toolTarget: target });
    garden.patch(id, { status: 'working', tool, toolTarget: target });
    spend(id, cost[0], cost[1]);
    feedPty(id, `${GREEN}⏺${RESET} ${BOLD}${tool}${RESET}(${target})${NL}`);
    await wait(650);
    feedPty(id, `  ${DIM}⎿${RESET}  ${result}${NL}${NL}`);
  };

  const say = (id: string, text: string): void => feedPty(id, `${RESET}⏺ ${text}${NL}${NL}`);

  /** Walk a parent over near its roaming battler (Walker.goTo — the same call
   *  GardenCharm's errands use) so the completion battle's approach is a few
   *  tiles, not a trek from the far corner wild battlers roam to. */
  const walkToward = (parentId: string): void => {
    const rt = garden.runtime(parentId);
    const pos = lastBattlerKey ? garden.battles.getBattlerPosition(lastBattlerKey) : undefined;
    if (!rt || !pos) return;
    const tx = Math.floor(pos.x / 16);
    const ty = Math.floor((pos.y - 1) / 16);
    const offsets = [[-3, 1], [3, 1], [-3, -1], [3, -1], [0, 3], [0, -3], [-2, 2], [2, 2], [-4, 0], [4, 0]];
    for (const [dx, dy] of offsets) if (rt.walker.goTo({ x: tx + dx, y: ty + dy })) return;
  };

  /** Full completion battle for the most recent battler, then its recall. */
  const fight = async (parentId: string, attackTools: string[]): Promise<void> => {
    const key = lastBattlerKey;
    if (!key) return;
    emitBattleSignal({ type: 'end', parentId });
    garden.setCamera({ kind: 'battle', parentId, key, zoom: 2.4 });
    await until(() => garden.battles.isBattling(parentId), 9000);
    for (const tool of attackTools) {
      await wait(1400);
      emitBattleSignal({ type: 'attack', parentId, tool });
    }
    await until(() => doneKeys.has(key), 24000);
    await wait(1000);
    garden.battles.despawnBattler(key);
    await wait(1200);
  };

  const select = (id: string | null, zoom = 2.4): void => {
    useStore.getState().select(id);
    garden.setCamera(id ? { kind: 'walker', id, zoom } : { kind: 'fit' });
  };

  // --- the script -----------------------------------------------------------
  const runOnce = async (): Promise<void> => {
    garden.setNight('day');
    useAppSettingsStore.getState().setDayNightMode('auto');
    garden.setCamera({ kind: 'fit' });

    // 1. a new session hatches
    caption('new session');
    await wait(900);
    spawn('dev-work', 'dev-work-main', 'pikachu', { cwd: '~/Developer/dev-work' });
    select('dev-work');
    banner('dev-work', '~/Developer/dev-work');
    await wait(900);
    await prompt('dev-work', 'add retry with backoff to the forecast fetcher');
    status('dev-work', 'working');

    // 2. tool calls
    caption('live tool calls');
    await toolCall('dev-work', 'Read', 'src/api/forecast.ts', 'Read 142 lines', [0.04, 6200]);
    await wait(700);
    await toolCall('dev-work', 'Edit', 'src/api/forecast.ts', 'Updated src/api/forecast.ts with 18 additions and 4 removals', [0.07, 9800]);
    await wait(700);
    await toolCall('dev-work', 'Bash', 'npm test', `${GREEN}PASS${RESET} src/api/forecast.test.ts (12 tests)`, [0.03, 4100]);
    await wait(600);

    // 3. a subagent spawns
    caption('subagent');
    garden.setExcludedLines(onlyLine('gastly'));
    await toolCall('dev-work', 'Task', 'audit the error paths', 'Running in the background…', [0.02, 2400]);
    emitBattleSignal({ type: 'spawn', parentId: 'dev-work', label: 'audit the error paths', toolUseId: 'toolu_reel_1' });
    await wait(500);
    if (lastBattlerKey) garden.setCamera({ kind: 'battle', parentId: 'dev-work', key: lastBattlerKey, zoom: 1.8 });
    await wait(900);
    emitBattleSignal({ type: 'subTool', parentId: 'dev-work', subagentId: 'agent_reel_1', tool: 'Grep', toolTarget: 'catch (err)' });
    walkToward('dev-work');
    await wait(1300);
    emitBattleSignal({ type: 'subTool', parentId: 'dev-work', subagentId: 'agent_reel_1', tool: 'Read', toolTarget: 'src/api/http.ts' });
    await toolCall('dev-work', 'Edit', 'src/api/retry.ts', 'Created src/api/retry.ts (41 lines)', [0.05, 7300]);
    await wait(700);

    // 4. subagent battle
    caption('subagent battle');
    say('dev-work', `Agent "audit the error paths" completed ${DIM}· 9 tool uses · 14.2k tokens${RESET}`);
    status('dev-work', 'idle');
    await fight('dev-work', ['Edit', 'Bash']);

    // 5. evolution
    caption('evolution');
    select('dev-work', 2.8);
    await wait(700);
    garden.evolve('dev-work');
    await until(() => !!garden.runtime('dev-work')?.walker.isEvolving, 3000);
    await until(() => !garden.runtime('dev-work')?.walker.isEvolving, 14000);
    update('dev-work', { pokemon: garden.sessions.get('dev-work')?.pokemon ?? 'raichu' });
    await wait(1200);

    // 6. shiny
    caption('shiny');
    spawn('portfolio', 'portfolio-dev', 'eevee', { shiny: true, cwd: '~/Developer/portfolio' });
    select('portfolio', 2.8);
    banner('portfolio', '~/Developer/portfolio');
    await prompt('portfolio', 'tighten the landing page copy');
    status('portfolio', 'working');
    await toolCall('portfolio', 'Read', 'src/pages/index.astro', 'Read 214 lines', [0.03, 5100]);
    await wait(1500);

    // 7. mega evolution (Charizard mega-evolves as the parent in its battle)
    caption('mega evolution');
    spawn('zenith', 'zenith-comeback', 'charizard', { cwd: '~/Developer/zenith' });
    select('zenith');
    banner('zenith', '~/Developer/zenith');
    await prompt('zenith', 'migrate the session store to sqlite');
    status('zenith', 'working');
    await toolCall('zenith', 'Read', 'src/store/sessions.ts', 'Read 388 lines', [0.06, 11200]);
    garden.setExcludedLines(onlyLine('psyduck'));
    await toolCall('zenith', 'Task', 'write the migration tests', 'Running in the background…', [0.02, 2600]);
    emitBattleSignal({ type: 'spawn', parentId: 'zenith', label: 'write the migration tests', toolUseId: 'toolu_reel_2' });
    await wait(700);
    if (lastBattlerKey) garden.setCamera({ kind: 'battle', parentId: 'zenith', key: lastBattlerKey, zoom: 1.8 });
    walkToward('zenith');
    await wait(2000);
    say('zenith', `Agent "write the migration tests" completed ${DIM}· 14 tool uses · 22.8k tokens${RESET}`);
    status('zenith', 'idle');
    await fight('zenith', ['Bash']);

    // 8. arceus fans work out to new sessions
    caption('arceus fan-out');
    useStore.getState().addSession(
      {
        id: ARCEUS_SESSION_ID,
        title: ARCEUS_TITLE,
        cwd: '~/Developer',
        command: 'claude',
        provider: 'claude',
        model: 'claude-fable-5',
        pokemon: 'arceus',
        line: 'arceus',
        shiny: false,
        isArceus: true
      },
      { select: false }
    );
    createTerminal(ARCEUS_SESSION_ID, 'shell');
    update(ARCEUS_SESSION_ID, { status: 'working' });
    spend(ARCEUS_SESSION_ID, 0.12, 21_000);
    useStore.getState().select(ARCEUS_SESSION_ID);
    await wait(900);
    const children: [string, string, string, string][] = [
      ['pixel-town', 'spotify-pixel-town-dev', 'bulbasaur', 'build the now-playing sprite'],
      ['docs', 'docs-rewrite', 'totodile', 'rewrite the getting-started page'],
      ['infra', 'infra-migrate', 'cyndaquil', 'move the cron jobs to workers']
    ];
    useStore.getState().pushArceusExchange({ who: 'you', text: 'ship the spotify pixel-town build, docs and infra this week' });
    await wait(900);
    for (const [, title, , task] of children) {
      useStore.getState().pushArceusExchange({ who: 'arceus', text: `dispatched ${title}: ${task}` });
      spend(ARCEUS_SESSION_ID, 0.03, 3100);
      await wait(700);
    }
    await wait(600);
    for (const [id, title, pokemon, task] of children) {
      spawn(id, title, pokemon, { cwd: `~/Developer/${id}`, model: 'claude-sonnet-5' });
      useStore.getState().select(ARCEUS_SESSION_ID);
      status(id, 'working');
      spend(id, 0.02, 3000);
      feedPty(id, `${DIM}>${RESET} ${task}${NL}${NL}`);
      await wait(350);
    }
    await wait(900);
    useStore.getState().select('dev-work');
    garden.setCamera({ kind: 'wide' });
    for (const [id] of children) {
      update(id, { tool: 'Read', toolTarget: 'README.md' });
      garden.patch(id, { tool: 'Read', toolTarget: 'README.md' });
    }
    for (const id of ['dev-work', 'portfolio', 'zenith']) status(id, 'working');
    garden.patch('dev-work', { tool: 'Bash', toolTarget: 'npm run build' });
    garden.patch('zenith', { tool: 'Edit', toolTarget: 'src/store/sqlite.ts' });
    update(ARCEUS_SESSION_ID, { status: 'idle' });
    await wait(3000);

    // 9. day/night
    caption('day and night');
    useAppSettingsStore.getState().setDayNightMode('night');
    for (let h = 18.4; h <= 21; h += 0.12) {
      garden.setNight(h);
      await wait(140);
    }
    await wait(2800);
    els.stage.classList.add('reel-fading');
    await wait(900);
  };

  const resetAll = (): void => {
    garden.reset();
    for (const s of useStore.getState().sessions) disposeTerminal(s.id);
    seedStores();
    lastBattlerKey = null;
    doneKeys.clear();
  };

  const loop = async (): Promise<void> => {
    try {
      for (;;) {
        await runOnce();
        resetAll();
        await wait(300);
        els.stage.classList.remove('reel-fading');
      }
    } catch (e) {
      if (!(e instanceof Stopped)) console.error('[showreel] script failed', e);
    }
  };
  void loop();

  return {
    setPaused: (paused) => garden.setPaused(paused),
    destroy() {
      stopped = true;
      for (const t of timers.splice(0)) t.reject(new Stopped());
      for (const w of waits.splice(0)) w.reject(new Stopped());
      window.removeEventListener('reel:battler', onBattler);
      garden.destroy();
      win.destroy();
    }
  };
}
