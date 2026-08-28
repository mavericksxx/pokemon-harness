/**
 * The full Gen 1-9 dex (#1-1025), for the picker's search (Phase 3 §2,
 * extended to the full dex in Phase 6 §1). This is the canonical source of
 * line/stage/evolvesTo/locomotion for every species — including the ones
 * that are not bundled and load lazily (`lazySprites.ts`). `showdownArt.ts`'s
 * manifest covers only the 42 bundled sheets; this covers all of them, so
 * evolution and line-uniqueness work the same way regardless of where a
 * species' art comes from.
 *
 * Species #1-649 use Showdown's animated Gen-5 sprites (`gen5ani`). Species
 * #650-1025 (Gen 6-9) have no such animation, so they use the Smogon Sprite
 * Project's fan-made Gen-5-STYLE STATIC sprites instead (`gen5`) and are
 * flagged `static: true` — see `assets/ASSETS.md` and `tools/build-dex.cjs`.
 * Regenerate both JSON files with `npm run gen:dex`.
 */
import dexIndexRaw from '@assets/dex/dexIndex.json';
import linesRaw from '@assets/dex/lines.json';
import type { Locomotion } from './showdownArt';
import { BUNDLED_BY_NAME } from './showdownArt';
import { ARCEUS_DEX_ID } from '@shared/arceus';

export interface DexEntry {
  id: string;
  name: string;
  num: number;
  line: string;
  stage: number;
  evolvesTo: string[];
  locomotion: Locomotion;
  hasSprite: boolean;
  /** Gen 6-9 species (#650-1025): a Smogon Sprite Project static PNG rather
   *  than an animated gen5ani sheet. Omitted (falsy) for #1-649. Static
   *  species are picker-only (Phase 6 §4) — they never appear in a random
   *  pool, only reachable by manual search/pick or by evolving into one. */
  static?: boolean;
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
 *  the line was picked. A line's id IS its stage-1 species' own id (how
 *  `tools/build-dex.cjs` assigns lines), so this is a direct lookup rather
 *  than a scan over all ~1025 species. */
export function baseStageOf(id: string): DexEntry {
  const entry = DEX[id];
  if (!entry) throw new Error(`unknown dex id: ${id}`);
  return DEX[entry.line] ?? entry;
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

/**
 * Random-eligible pick among a set of candidate species ids, for any code
 * that draws a random NEXT species rather than a specific one (Phase 6 §4)
 * — currently the evolution ceremony's branching-line pick (Eevee and
 * friends). Static (Gen 6-9 Smogon) species are picker-only: they can never
 * be the OUTCOME OF A RANDOM DRAW.
 *
 * A single candidate isn't a random pick at all — Math.random() over one
 * option is deterministic — so a LINEAR evolution (e.g. Bisharp -> Kingambit)
 * always proceeds even into a static target; only an actual branch (2+
 * candidates, e.g. Eevee's evolutions, or Scyther's Scizor/Kleavor split)
 * has its static options filtered out before the random draw.
 *
 * Returns undefined when there is nothing eligible to become (no candidates,
 * or a branch where every option is static) — the caller should treat that
 * as "no further evolution here" rather than force a static evolution the
 * player didn't choose.
 */
export function randomAnimatedSpecies(candidateIds: readonly string[]): string | undefined {
  if (candidateIds.length <= 1) return candidateIds[0];
  // Belt-and-braces (Phase 8.8): Arceus already can't reach this filter in
  // practice — he isn't in the bundled roster pickFreeLine draws from, and
  // no species lists him in `evolvesTo` — but he's excluded here explicitly
  // too, same as `static` species, since this is the one function every
  // "pick something to randomly become" path already funnels through.
  const eligible = candidateIds.filter((id) => !DEX[id]?.static && id !== ARCEUS_DEX_ID);
  if (eligible.length === 0) return undefined;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// `stageForWorkedMs` (resolved a manually-picked species to whatever stage a
// session's already-accumulated `workedMs` had earned in the new line) was
// removed here (Phase C follow-up: change-pokemon stage semantics) — swaps
// are now exact-species, not earned-stage-normalized; see sessions.ts's
// `swapSessionPokemon`.
