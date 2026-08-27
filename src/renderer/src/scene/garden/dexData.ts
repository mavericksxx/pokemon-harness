/**
 * The full Gen 1-5 dex, for the picker's search (Phase 3 §2). This is the
 * canonical source of line/stage/evolvesTo for every one of the 649 species —
 * including the 607 that are not bundled and load lazily (`lazySprites.ts`).
 * `showdownArt.ts`'s manifest covers only the 42 bundled sheets; this covers
 * all of them, so evolution and line-uniqueness work the same way regardless
 * of where a species' art comes from.
 */
import dexIndexRaw from '@assets/dex/dexIndex.json';
import linesRaw from '@assets/dex/lines.json';
import type { Locomotion } from './showdownArt';
import { BUNDLED_BY_NAME } from './showdownArt';

export interface DexEntry {
  id: string;
  name: string;
  num: number;
  line: string;
  stage: number;
  evolvesTo: string[];
  locomotion: Locomotion;
  hasSprite: boolean;
}

export interface DexLine {
  line: string;
  members: string[];
  displayName: string;
}

export const DEX: Readonly<Record<string, DexEntry>> = dexIndexRaw as Record<string, DexEntry>;
export const LINES: readonly DexLine[] = linesRaw as DexLine[];

const LINES_BY_ID = new Map(LINES.map((l) => [l.line, l]));

/** Dex-number order, for the picker's default (empty-query) listing. */
export const DEX_LIST: readonly DexEntry[] = Object.values(DEX).sort((a, b) => a.num - b.num);

export function speciesEntry(id: string): DexEntry | undefined {
  return DEX[id];
}

export function lineOf(id: string): DexLine | undefined {
  const entry = DEX[id];
  return entry ? LINES_BY_ID.get(entry.line) : undefined;
}

/** The line's stage-1 species — sessions always hatch here, whatever stage of
 *  the line was picked. */
export function baseStageOf(id: string): DexEntry {
  const entry = DEX[id];
  if (!entry) throw new Error(`unknown dex id: ${id}`);
  const base = DEX_LIST.find((e) => e.line === entry.line && e.stage === 1);
  return base ?? entry;
}

/** True for the 42 species whose sprite sheets ship with the app; false means
 *  the picker/lazySprites must fetch and cache art at runtime. */
export function isBundled(id: string): boolean {
  return BUNDLED_BY_NAME.has(id);
}

/**
 * Human-readable evolution chain for the picker's inline note, e.g.
 * "Gastly → Haunter → Gengar" or, for a branching line, "Eevee → Vaporeon,
 * Jolteon, Flareon, Espeon, Umbreon, Leafeon, or Glaceon".
 */
export function chainLabel(lineId: string): string {
  const line = LINES_BY_ID.get(lineId);
  if (!line) return '';
  const base = DEX[line.members[0]];
  if (!base) return line.displayName;
  if (base.evolvesTo.length <= 1) {
    return line.members.map((m) => DEX[m]?.name ?? m).join(' → ');
  }
  const branches = base.evolvesTo.map((m) => DEX[m]?.name ?? m);
  const last = branches.pop();
  return `${base.name} → ${branches.join(', ')}, or ${last}`;
}

/** Type-ahead search over name or dex number. Empty query returns nothing —
 *  the picker shows the bundled roster by default instead. */
export function searchDex(query: string, limit = 30): DexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const asNumber = /^\d+$/.test(q) ? Number(q) : null;
  const results: DexEntry[] = [];
  for (const entry of DEX_LIST) {
    if (asNumber !== null ? entry.num === asNumber : entry.name.toLowerCase().includes(q)) {
      results.push(entry);
      if (results.length >= limit) break;
    }
  }
  return results;
}
