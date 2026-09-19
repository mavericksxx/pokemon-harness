/**
 * Scripted roster strip. Card structure and copy follow the app's
 * components/AgentRosterCard.tsx ("full" variant: face + shiny star, name,
 * provider, species, status pill, tool line, evolution bar, context bar) and
 * SubagentRosterCard.tsx (label, "↳ parent", "working — running 12s" /
 * "done — ran 41s"), restyled for the landing page. Faces come from the
 * app's own loadLazyThumbnail, served by the api shim's local sprites.
 */
import { loadLazyThumbnail } from '@/scene/garden/lazySprites';
import { speciesEntry } from '@/scene/garden/dexData';
import { statusLabel } from '@/design/statusLabel';
import type { SessionStatus } from '@shared/types';

export interface AgentCardInit {
  id: string;
  title: string;
  provider: string;
  pokemon: string;
  shiny?: boolean;
  accent: number;
  arceus?: boolean;
}

interface AgentCard {
  el: HTMLElement;
  cost: number;
  tokens: number;
}

interface SubCard {
  el: HTMLElement;
  spawnedAtMs: number;
  doneAtMs: number | null;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export class ReelRoster {
  private agents = new Map<string, AgentCard>();
  private subs = new Map<string, SubCard>();
  /** Reel clock, ms — advanced by tick(); drives the subagent elapsed readouts. */
  private nowMs = 0;

  constructor(private root: HTMLElement) {}

  private face(pokemon: string, shiny: boolean, slot: HTMLElement): void {
    void loadLazyThumbnail(pokemon, shiny).then((url) => {
      if (url) slot.style.backgroundImage = `url(${url})`;
    });
  }

  addAgent(init: AgentCardInit): void {
    const card = el('div', `reel-card${init.arceus ? ' reel-card-arceus' : ''}`);
    card.style.borderLeftColor = init.arceus ? '' : hex(init.accent);
    const top = el('div', 'reel-card-top');
    const face = el('span', 'reel-card-face');
    const faceImg = el('span', 'reel-card-face-img');
    face.appendChild(faceImg);
    if (init.shiny) {
      const star = el('span', 'reel-card-shiny', '★');
      star.title = 'shiny';
      face.appendChild(star);
    }
    const id = el('span', 'reel-card-id');
    id.append(
      el('span', 'reel-card-name', init.title),
      el('span', 'reel-card-provider', init.provider),
      el('span', 'reel-card-species', (speciesEntry(init.pokemon)?.name ?? init.pokemon).toLowerCase())
    );
    const status = el('em', 'reel-status starting', statusLabel('starting'));
    top.append(face, id, status);
    const tool = el('div', 'reel-card-tool', ' ');
    const meta = el('div', 'reel-card-meta');
    meta.append(el('span', 'reel-card-cost', '$0.00'), el('span', 'reel-card-tokens', '0 tok'));
    const ctx = el('div', 'reel-card-ctx');
    ctx.append(el('span', 'reel-card-ctx-label', 'context'));
    const bar = el('div', 'reel-bar');
    bar.appendChild(el('div', 'reel-bar-fill'));
    ctx.append(bar, el('span', 'reel-card-ctx-pct', '0%'));
    card.append(top, tool, meta, ctx);
    card.dataset.id = init.id;
    this.root.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
    this.agents.set(init.id, { el: card, cost: 0, tokens: 0 });
    this.face(init.arceus ? 'arceus' : init.pokemon, !!init.shiny, faceImg);
  }

  setStatus(id: string, status: SessionStatus): void {
    const card = this.agents.get(id);
    if (!card) return;
    const pill = card.el.querySelector<HTMLElement>('.reel-status')!;
    pill.className = `reel-status ${status}`;
    pill.textContent = statusLabel(status);
  }

  setTool(id: string, text: string): void {
    const card = this.agents.get(id);
    if (card) card.el.querySelector<HTMLElement>('.reel-card-tool')!.textContent = text || ' ';
  }

  setSpecies(id: string, pokemon: string, shiny = false): void {
    const card = this.agents.get(id);
    if (!card) return;
    card.el.querySelector<HTMLElement>('.reel-card-species')!.textContent = (
      speciesEntry(pokemon)?.name ?? pokemon
    ).toLowerCase();
    this.face(pokemon, shiny, card.el.querySelector<HTMLElement>('.reel-card-face-img')!);
  }

  /** One tool call's worth of spend — cost/tokens/context all tick up. */
  spend(id: string, dollars: number, tokens: number): void {
    const card = this.agents.get(id);
    if (!card) return;
    card.cost += dollars;
    card.tokens += tokens;
    card.el.querySelector<HTMLElement>('.reel-card-cost')!.textContent = `$${card.cost.toFixed(2)}`;
    card.el.querySelector<HTMLElement>('.reel-card-tokens')!.textContent = `${formatTokens(card.tokens)} tok`;
    const pct = Math.min(92, Math.round((card.tokens / 200_000) * 100));
    card.el.querySelector<HTMLElement>('.reel-card-ctx-pct')!.textContent = `${pct}%`;
    card.el.querySelector<HTMLElement>('.reel-bar-fill')!.style.setProperty('--fill', String(pct / 100));
  }

  setSelected(id: string | null): void {
    for (const [cardId, card] of this.agents) card.el.classList.toggle('selected', cardId === id);
  }

  addSub(key: string, parentId: string, species: string, label?: string): void {
    const parentTitle = this.agents.get(parentId)?.el.querySelector('.reel-card-name')?.textContent ?? '';
    const card = el('div', 'reel-card reel-card-sub');
    const top = el('div', 'reel-card-top');
    const face = el('span', 'reel-card-face');
    const faceImg = el('span', 'reel-card-face-img');
    face.appendChild(faceImg);
    const id = el('span', 'reel-card-id');
    const speciesName = (speciesEntry(species)?.name ?? species).toLowerCase();
    id.append(el('span', 'reel-card-name', label || speciesName), el('span', 'reel-card-species', `${speciesName} · ↳ ${parentTitle}`));
    top.append(face, id, el('span', 'reel-dot working'));
    card.append(top, el('div', 'reel-card-elapsed', 'working — running 0s'));
    // Sits right under its parent, like the app's per-parent disclosure.
    const parentEl = this.agents.get(parentId)?.el;
    let anchor: Element | null | undefined = parentEl;
    while (anchor?.nextElementSibling?.classList.contains('reel-card-sub')) anchor = anchor.nextElementSibling;
    if (anchor) anchor.after(card);
    else this.root.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
    this.subs.set(key, { el: card, spawnedAtMs: this.nowMs, doneAtMs: null });
    this.face(species, false, faceImg);
  }

  subDone(key: string, done: boolean): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    sub.doneAtMs = done ? this.nowMs : null;
    sub.el.querySelector('.reel-dot')!.className = `reel-dot ${done ? 'done' : 'working'}`;
    this.renderElapsed(sub);
  }

  removeSub(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    sub.el.classList.remove('in');
    window.setTimeout(() => sub.el.remove(), 350);
  }

  private renderElapsed(sub: SubCard): void {
    const text =
      sub.doneAtMs !== null
        ? `done — ran ${formatElapsed(sub.doneAtMs - sub.spawnedAtMs)}`
        : `working — running ${formatElapsed(this.nowMs - sub.spawnedAtMs)}`;
    sub.el.querySelector<HTMLElement>('.reel-card-elapsed')!.textContent = text;
  }

  tick(dtMs: number): void {
    const before = Math.floor(this.nowMs / 1000);
    this.nowMs += dtMs;
    if (Math.floor(this.nowMs / 1000) === before) return;
    for (const sub of this.subs.values()) if (sub.doneAtMs === null) this.renderElapsed(sub);
  }

  clear(): void {
    this.root.textContent = '';
    this.agents.clear();
    this.subs.clear();
  }
}
