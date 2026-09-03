/**
 * Mega Evolution — battle-only (Phase: mega evolution during battles).
 *
 * A parent Walker whose species is a key here mega-evolves for the duration
 * of a completion battle — triggered by BattleManager's `startMega`, prefetched
 * (cache-warming only) from `admitBattle` and actually applied from
 * `updateApproaching`'s one-time transition into `wave = 'faceoff'` (see
 * `startMega`'s own comment for why it's split across those two call sites
 * rather than living in `applyBattleStance`, which re-applies every tick and
 * isn't a safe home for an async trigger) — and reverts the instant the
 * parent's forced battle stance releases. No picker entries, no manual
 * toggle, no work-based trigger: this table and `pickMegaId` are the entire
 * selection surface.
 *
 * Sprite ids follow Showdown's gen5 naming (`<species>-mega`, or
 * `<species>-megax`/`-megay` for the two Kalos-split forms). The table covers
 * the complete classic/pre-Legends Z-A set: 48 real, official Mega Evolution
 * forms across 46 species. Art comes from either the BW-animated `gen5ani`
 * tier or the static `gen5` tier, which is the same static-image fallback used
 * by normal species #650-1025. Pokémon Legends: Z-A (released October 2025)
 * added roughly two dozen more real, official Mega Evolutions — including
 * Dragonite, Victreebel, Clefable, Meganium, Feraligatr, and Skarmory —
 * deliberately out of scope for this table and reserved for a separate,
 * larger follow-up with its own id-verification pass. Showdown's raw
 * `pokedex.json` also contains genuinely fan-made CAP entries under the same
 * `forme: "Mega"` shape; those are not official Mega Evolutions and remain
 * absent.
 * Every id below was curl-verified against the appropriate one of
 * `https://play.pokemonshowdown.com/sprites/gen5ani/<id>.gif` or
 * `https://play.pokemonshowdown.com/sprites/gen5/<id>.png` before being
 * added. A failed fetch still falls back to no mega (see
 * `loadMegaAnimation`), so keeping the table tied to those verified URLs
 * prevents a bad id from becoming a crash.
 */
import type { DexEntry } from './dexData';
import { speciesEntry } from './dexData';
import type { PokemonAnimation } from './showdownArt';
import { loadRawFrameSets } from './lazySprites';

/** Species id -> its mega form records. A single-entry array is the common
 *  case; two entries (X/Y) only for Charizard and Mewtwo. Each record carries
 *  the Showdown sprite id and sets `static: true` only for the PNG-backed
 *  `gen5` tier; omitted `static` means the animated `gen5ani` tier. */
const MEGA_FORMS: Readonly<Record<string, readonly { id: string; static?: boolean }[]>> = {
  venusaur: [{ id: 'venusaur-mega', static: true }],
  charizard: [{ id: 'charizard-megax' }, { id: 'charizard-megay', static: true }],
  blastoise: [{ id: 'blastoise-mega', static: true }],
  beedrill: [{ id: 'beedrill-mega' }],
  pidgeot: [{ id: 'pidgeot-mega', static: true }],
  alakazam: [{ id: 'alakazam-mega' }],
  slowbro: [{ id: 'slowbro-mega', static: true }],
  gengar: [{ id: 'gengar-mega', static: true }],
  kangaskhan: [{ id: 'kangaskhan-mega', static: true }],
  pinsir: [{ id: 'pinsir-mega', static: true }],
  gyarados: [{ id: 'gyarados-mega', static: true }],
  aerodactyl: [{ id: 'aerodactyl-mega', static: true }],
  mewtwo: [{ id: 'mewtwo-megax' }, { id: 'mewtwo-megay' }],
  ampharos: [{ id: 'ampharos-mega' }],
  steelix: [{ id: 'steelix-mega' }],
  scizor: [{ id: 'scizor-mega' }],
  heracross: [{ id: 'heracross-mega', static: true }],
  houndoom: [{ id: 'houndoom-mega', static: true }],
  tyranitar: [{ id: 'tyranitar-mega' }],
  sceptile: [{ id: 'sceptile-mega', static: true }],
  blaziken: [{ id: 'blaziken-mega' }],
  swampert: [{ id: 'swampert-mega', static: true }],
  gardevoir: [{ id: 'gardevoir-mega' }],
  sableye: [{ id: 'sableye-mega', static: true }],
  mawile: [{ id: 'mawile-mega' }],
  aggron: [{ id: 'aggron-mega', static: true }],
  medicham: [{ id: 'medicham-mega' }],
  manectric: [{ id: 'manectric-mega' }],
  sharpedo: [{ id: 'sharpedo-mega', static: true }],
  camerupt: [{ id: 'camerupt-mega', static: true }],
  altaria: [{ id: 'altaria-mega', static: true }],
  banette: [{ id: 'banette-mega' }],
  absol: [{ id: 'absol-mega' }],
  glalie: [{ id: 'glalie-mega' }],
  salamence: [{ id: 'salamence-mega' }],
  metagross: [{ id: 'metagross-mega', static: true }],
  latias: [{ id: 'latias-mega' }],
  latios: [{ id: 'latios-mega' }],
  rayquaza: [{ id: 'rayquaza-mega' }],
  lopunny: [{ id: 'lopunny-mega', static: true }],
  garchomp: [{ id: 'garchomp-mega' }],
  lucario: [{ id: 'lucario-mega' }],
  abomasnow: [{ id: 'abomasnow-mega' }],
  gallade: [{ id: 'gallade-mega', static: true }],
  audino: [{ id: 'audino-mega', static: true }],
  diancie: [{ id: 'diancie-mega', static: true }]
};

/** FNV-1a — duplicated from BattleManager.ts's own (unexported) `hashString`
 *  rather than imported, same reasoning as that file's own
 *  `BATTLER_SPEED_PX_S` comment: it's a one-line pure function, not worth a
 *  cross-module dependency for. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** Deterministic per-battle pick among a species' mega form(s) — hashed off
 *  `battleKey` (the caller passes something unique per battle instance, e.g.
 *  a parent id + wave start time) so the SAME battle always shows the same
 *  form and different battles alternate between X/Y over time, never a
 *  random re-roll mid-fight. Undefined for a species with no mega form at
 *  all. */
export function pickMegaId(speciesId: string, battleKey: string): string | undefined {
  const forms = MEGA_FORMS[speciesId];
  if (!forms || forms.length === 0) return undefined;
  if (forms.length === 1) return forms[0].id;
  return forms[hashString(battleKey) % forms.length].id;
}

/** Whether a mega id (as returned by pickMegaId) is on the static-image tier
 *  rather than the animated gen5ani tier — scans MEGA_FORMS since a mega id
 *  has no DexEntry of its own to carry this flag. */
export function isMegaFormStatic(megaId: string): boolean {
  for (const forms of Object.values(MEGA_FORMS)) {
    const match = forms.find((f) => f.id === megaId);
    if (match) return !!match.static;
  }
  return false;
}

// A species can mix tiers (Charizard's Mega-X is animated while Mega-Y is
// static), so a hash-picked battle may intentionally show a still frame.
// This is consistent with the garden already mixing animated and static art.

/** Build the mega form's PokemonAnimation by fetching its gen5ani or gen5 sheet(s)
 *  through the same lazy-sprite pipeline every other runtime-loaded species
 *  uses (`loadRawFrameSets` — shiny falls back to normal on a 404, which
 *  then falls back to no mega at all if THAT 404s too, same as any other
 *  lazy pick). The mega id has no DexEntry of its own (it's not a real
 *  picker species), so dex/line/stage/evolvesTo are borrowed from the BASE
 *  species purely for bookkeeping — nothing reads them while a temporary
 *  form is showing (see Walker.setTemporaryForm). */
export async function loadMegaAnimation(
  baseId: string,
  megaId: string,
  shiny: boolean,
  kind: 'animated' | 'static'
): Promise<PokemonAnimation | null> {
  const frames = await loadRawFrameSets(megaId, shiny, kind);
  if (!frames) return null;
  const base: DexEntry | undefined = speciesEntry(baseId);
  return {
    info: {
      name: megaId,
      dex: base?.num ?? 0,
      label: base ? `Mega ${base.name}` : megaId,
      locomotion: base?.locomotion ?? 'walk',
      frameWidth: frames.front.frameWidth,
      frameHeight: frames.front.frameHeight,
      sheetUrl: '',
      line: base?.line ?? baseId,
      stage: base?.stage ?? 1,
      evolvesTo: [],
      hasBack: !!frames.back
    },
    front: frames.front,
    back: frames.back
  };
}
