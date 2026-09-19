/**
 * The showreel's director: a looping script that drives the app's real
 * garden (garden.ts) through every headline feature, while the scripted
 * terminal/roster panes narrate it. Everything runs on one clock advanced by
 * the Pixi ticker, so pausing the ticker (off-screen, hidden tab) pauses the
 * whole reel in lockstep.
 *
 * What's real vs scripted:
 *   real  — map, walkers, tool bubbles, spawn beat, wild-battler spawn and
 *           roam, the whole battle (BattleManager, fed through battleBus's
 *           emitBattleSignal exactly like hookRouter does), evolution
 *           ceremony, shiny reveal (walkerLifecycle's lazy-sprite upgrade),
 *           mega ceremony (BattleManager.startMega -> Walker.startMegaCeremony),
 *           Arceus warp (ArceusWarp.tsx), day/night overlay.
 *   scripted — the order of events, terminal text, roster cards, captions.
 */
import './apiShim';
import { emitBattleSignal } from '@/scene/garden/battle/battleBus';
import { POKEMON_ROSTER } from '@/scene/garden/showdownArt';
import { formatToolTarget } from '@/design/toolTargetLabel';
import { mountShowreel, type ReelGarden, type ReelSession } from './garden';
import { mountArceus, type ArceusStage } from './arceus';
import { ReelTerminal } from './terminal';
import { ReelRoster } from './roster';

export interface ReelElements {
  stage: HTMLElement;
  host: HTMLDivElement;
  warp: HTMLElement;
  terminal: HTMLElement;
  roster: HTMLElement;
  caption: HTMLElement;
  hud: HTMLElement;
}

export interface ReelController {
  setPaused(paused: boolean): void;
  setBackground(color: number): void;
  destroy(): void;
}

/** Thrown into a pending wait when the reel is destroyed, unwinding the script. */
class Stopped extends Error {}

const BUNDLED_LINES = [...new Set(POKEMON_ROSTER.map((p) => p.line))];
/** Every bundled line but `keep`: BattleManager's own species picker (fed
 *  through its injectable `activeSessionLines`) then has exactly one
 *  eligible bundled base form left, so the wild battler is deterministic. */
const onlyLine = (keep: string): string[] => BUNDLED_LINES.filter((l) => l !== keep);

export async function startReel(els: ReelElements, background: number): Promise<ReelController> {
  const garden: ReelGarden = await mountShowreel(els.host, background);
  const arceus: ArceusStage = mountArceus(els.warp, els.host);

  // --- clock ---------------------------------------------------------------
  let now = 0;
  let stopped = false;
  const timers: { at: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const waits: { pred: () => boolean; deadline: number; resolve: (ok: boolean) => void; reject: (e: Error) => void }[] = [];
  const roster = new ReelRoster(els.roster);
  garden.onTick((dt) => {
    now += dt;
    roster.tick(dt);
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

  const term = new ReelTerminal(els.terminal, wait);

  // --- battler bookkeeping (BattleDeps callbacks -> roster) -----------------
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
    if (d.event === 'spawn') {
      lastBattlerKey = d.key;
      roster.addSub(d.key, d.parentId!, d.species!, d.label);
    } else if (d.event === 'done') {
      if (d.done) doneKeys.add(d.key);
      roster.subDone(d.key, !!d.done);
    } else {
      roster.removeSub(d.key);
    }
  };
  window.addEventListener('reel:battler', onBattler);

  // --- helpers --------------------------------------------------------------
  const caption = (fig: string, text: string): void => {
    if (import.meta.env.DEV) console.debug(`[showreel] ${fig} at ${(now / 1000).toFixed(1)}s`);
    els.caption.classList.remove('in');
    void els.caption.offsetWidth;
    els.caption.innerHTML = '';
    const num = document.createElement('span');
    num.className = 'reel-caption-fig';
    num.textContent = fig;
    els.caption.append(num, document.createTextNode(` ${text}`));
    els.caption.classList.add('in');
  };

  const session = (s: Omit<ReelSession, 'status'> & { provider: string; arceus?: boolean }): void => {
    garden.upsert({ ...s, status: 'starting' });
    roster.addAgent({ id: s.id, title: s.title, provider: s.provider, pokemon: s.pokemon, shiny: s.shiny, accent: s.accent });
  };

  const status = (id: string, st: ReelSession['status']): void => {
    garden.patch(id, { status: st, ...(st === 'working' ? {} : { tool: undefined, toolTarget: undefined }) });
    roster.setStatus(id, st);
    if (st !== 'working') roster.setTool(id, '');
  };

  /** One real-looking tool call: walker bubble + roster tool line/spend + terminal. */
  const toolCall = async (id: string, tool: string, target: string, result: string, spend: [number, number]): Promise<void> => {
    garden.patch(id, { status: 'working', tool, toolTarget: target });
    roster.setStatus(id, 'working');
    roster.setTool(id, `${tool.toLowerCase()} · ${formatToolTarget(tool, target)}`);
    roster.spend(id, spend[0], spend[1]);
    await term.tool(tool, target, result);
  };

  const select = (id: string | null): void => roster.setSelected(id);

  /** Walk a parent over near its roaming battler (Walker.goTo — the same
   *  call GardenCharm's errands use), so the completion battle's approach is
   *  a few tiles rather than a trek across the map from the far corner
   *  BattleManager roams wild battlers to. */
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
    garden.setCamera({ kind: 'battle', parentId, key, zoom: 2.2 });
    await until(() => garden.battles.isBattling(parentId), 9000);
    if (import.meta.env.DEV) console.debug(`[showreel] battle admitted at ${(now / 1000).toFixed(1)}s`);
    for (const tool of attackTools) {
      await wait(1400);
      emitBattleSignal({ type: 'attack', parentId, tool });
    }
    await until(() => doneKeys.has(key), 24000);
    if (import.meta.env.DEV) console.debug(`[showreel] battle done at ${(now / 1000).toFixed(1)}s`);
    await wait(1000);
    garden.battles.despawnBattler(key);
    await wait(1200);
  };

  // --- the script -----------------------------------------------------------
  const runOnce = async (): Promise<void> => {
    garden.setNight('day');
    garden.setCamera({ kind: 'wide' });
    roster.clear();

    // 1. spawn
    caption('fig. 1', 'hatching — start a session and it walks into the garden as a pokémon.');
    term.clear('~/code/weather-app');
    await wait(900);
    await term.type('$ claude', 'cmd');
    term.print('✻ welcome to claude code', 'banner');
    session({ id: 'pika', title: 'weather-app', provider: 'claude', pokemon: 'pikachu', shiny: false, accent: 0xffd166 });
    select('pika');
    garden.setCamera({ kind: 'walker', id: 'pika', zoom: 2.6 });
    await wait(900);
    await term.type('> add retry with backoff to the forecast fetcher', 'prompt', 26);
    status('pika', 'working');

    // 2. working
    caption('fig. 2', 'at work — every tool call shows up over its head, and the card tallies cost and tokens.');
    await toolCall('pika', 'Read', 'src/api/forecast.ts', 'Read 142 lines', [0.04, 6200]);
    await wait(800);
    await toolCall('pika', 'Edit', 'src/api/forecast.ts', 'Updated src/api/forecast.ts with 18 additions and 4 removals', [0.07, 9800]);
    await wait(800);
    await toolCall('pika', 'Bash', 'npm test', 'PASS  src/api/forecast.test.ts  (12 tests)', [0.03, 4100]);
    await wait(700);

    // 3. subagent spawn
    caption('fig. 3', 'subagents — a task call summons a wild pokémon with its own card.');
    garden.setExcludedLines(onlyLine('gastly'));
    await toolCall('pika', 'Task', 'audit the error paths', 'Running in the background…', [0.02, 2400]);
    emitBattleSignal({ type: 'spawn', parentId: 'pika', label: 'audit the error paths', toolUseId: 'toolu_reel_1' });
    await wait(400);
    if (lastBattlerKey) garden.setCamera({ kind: 'battle', parentId: 'pika', key: lastBattlerKey, zoom: 1.7 });
    await wait(900);
    emitBattleSignal({ type: 'subTool', parentId: 'pika', subagentId: 'agent_reel_1', tool: 'Grep', toolTarget: 'catch (err)' });
    term.print('  ⎿  Grep(catch (err))  · subagent', 'dim');
    walkToward('pika');
    await wait(1300);
    emitBattleSignal({ type: 'subTool', parentId: 'pika', subagentId: 'agent_reel_1', tool: 'Read', toolTarget: 'src/api/http.ts' });
    term.print('  ⎿  Read(src/api/http.ts)  · subagent', 'dim');
    await toolCall('pika', 'Edit', 'src/api/retry.ts', 'Created src/api/retry.ts (41 lines)', [0.05, 7300]);
    await wait(700);

    // 4. battle
    caption('fig. 4', 'battles — when the subagent finishes, it walks up and fights its parent, then heads home.');
    term.print('● agent "audit the error paths" completed', 'ok');
    term.print('  ⎿  Done (9 tool uses · 14.2k tokens · 38s)', 'result');
    status('pika', 'idle');
    await fight('pika', ['Edit', 'Bash']);

    // 5. evolution
    caption('fig. 5', 'evolution — enough working time and a session evolves, ceremony and all.');
    garden.setCamera({ kind: 'walker', id: 'pika', zoom: 2.9 });
    await wait(900);
    garden.evolve('pika');
    await until(() => !!garden.runtime('pika')?.walker.isEvolving, 3000);
    await until(() => !garden.runtime('pika')?.walker.isEvolving, 14000);
    roster.setSpecies('pika', garden.sessions.get('pika')?.pokemon ?? 'raichu');
    term.print('✻ weather-app evolved into raichu', 'ok');
    await wait(1500);

    // 6. shiny
    caption('fig. 6', 'shiny — one session in sixty-four hatches shiny, and keeps its star for life.');
    term.clear('~/code/docs-site');
    session({ id: 'eevee', title: 'docs-site', provider: 'claude', pokemon: 'eevee', shiny: true, accent: 0x8ecae6 });
    select('eevee');
    garden.setCamera({ kind: 'walker', id: 'eevee', zoom: 2.9 });
    await term.type('$ claude', 'cmd', 30);
    await term.type('> tighten the landing page copy', 'prompt', 26);
    status('eevee', 'working');
    await toolCall('eevee', 'Read', 'src/pages/index.astro', 'Read 214 lines', [0.03, 5100]);
    await wait(2200);

    // 7. mega evolution
    caption('fig. 7', 'mega evolution — some species mega-evolve for the length of a battle, then revert.');
    term.clear('~/code/api-server');
    session({ id: 'zard', title: 'api-server', provider: 'claude', pokemon: 'charizard', shiny: false, accent: 0xff8fa3 });
    select('zard');
    garden.setCamera({ kind: 'walker', id: 'zard', zoom: 2.4 });
    await term.type('$ claude', 'cmd', 30);
    await term.type('> migrate the session store to sqlite', 'prompt', 26);
    status('zard', 'working');
    await toolCall('zard', 'Read', 'src/store/sessions.ts', 'Read 388 lines', [0.06, 11200]);
    garden.setExcludedLines(onlyLine('psyduck'));
    await toolCall('zard', 'Task', 'write the migration tests', 'Running in the background…', [0.02, 2600]);
    emitBattleSignal({ type: 'spawn', parentId: 'zard', label: 'write the migration tests', toolUseId: 'toolu_reel_2' });
    await wait(700);
    if (lastBattlerKey) garden.setCamera({ kind: 'battle', parentId: 'zard', key: lastBattlerKey, zoom: 1.7 });
    walkToward('zard');
    await wait(2000);
    term.print('● agent "write the migration tests" completed', 'ok');
    term.print('  ⎿  Done (14 tool uses · 22.8k tokens · 51s)', 'result');
    status('zard', 'idle');
    await fight('zard', ['Bash']);

    // 8. arceus
    caption('fig. 8', 'arceus — summon an orchestrator in the hall of origin; it fans work out to new sessions.');
    term.clear('arceus · hall of origin');
    roster.addAgent({ id: 'arceus', title: 'arceus', provider: 'claude', pokemon: 'arceus', accent: 0xe8b740, arceus: true });
    roster.setStatus('arceus', 'working');
    select('arceus');
    arceus.setAscended(true);
    await wait(900);
    els.hud.classList.add('visible');
    const hudList = els.hud.querySelector<HTMLElement>('[data-hud-list]')!;
    hudList.textContent = '';
    await term.type('> ship onboarding v2: api, tests and docs', 'prompt', 24);
    const children: [string, string, string, number, string][] = [
      ['onb-api', 'onboarding-api', 'bulbasaur', 0xb5e48c, 'build the signup endpoint'],
      ['onb-tests', 'onboarding-tests', 'totodile', 0xc8a2ff, 'cover the signup flow'],
      ['onb-docs', 'onboarding-docs', 'cyndaquil', 0xffb27a, 'write the getting-started page']
    ];
    for (const [, title, pokemon, , task] of children) {
      term.print(`● poke-tools dispatch(${title})`, 'tool');
      const row = document.createElement('li');
      row.textContent = `→ ${pokemon} · ${task}`;
      hudList.appendChild(row);
      roster.spend('arceus', 0.03, 3100);
      await wait(900);
    }
    await wait(700);
    els.hud.classList.remove('visible');
    arceus.setAscended(false);
    await wait(700);
    garden.setCamera({ kind: 'fit' });
    for (const [id, title, pokemon, accent, task] of children) {
      session({ id, title, provider: 'claude', pokemon, shiny: false, accent });
      roster.setStatus(id, 'working');
      garden.patch(id, { status: 'working', tool: 'Read', toolTarget: task.split(' ').pop() });
      await wait(500);
    }
    for (const id of ['pika', 'eevee', 'zard']) status(id, 'working');
    garden.patch('pika', { tool: 'Bash', toolTarget: 'npm run build' });
    garden.patch('zard', { tool: 'Edit', toolTarget: 'src/store/sqlite.ts' });
    await wait(3200);

    // 9. day/night
    caption('fig. 9', 'day and night — the garden keeps your local clock; lamps come on at dusk.');
    for (let h = 18.4; h <= 21; h += 0.12) {
      garden.setNight(h);
      await wait(140);
    }
    await wait(3000);
    els.stage.classList.add('reel-fading');
    await wait(900);
  };

  const loop = async (): Promise<void> => {
    try {
      for (;;) {
        await runOnce();
        garden.reset();
        roster.clear();
        lastBattlerKey = null;
        doneKeys.clear();
        els.hud.classList.remove('visible');
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
    setBackground: (color) => garden.setBackground(color),
    destroy() {
      stopped = true;
      for (const t of timers.splice(0)) t.reject(new Stopped());
      for (const w of waits.splice(0)) w.reject(new Stopped());
      window.removeEventListener('reel:battler', onBattler);
      arceus.destroy();
      garden.destroy();
    }
  };
}
