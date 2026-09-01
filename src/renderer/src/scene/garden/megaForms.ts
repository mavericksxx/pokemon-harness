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
 * Sprite ids follow Showdown's gen5ani naming (`<species>-mega`, or
 * `<species>-megax`/`-megay` for the two Kalos-split forms). Coverage is
 * NOT complete: gen5ani is the BW-animated fan sprite set, extended by
 * volunteers to cover mega evolutions unevenly — plenty of real mega forms
 * (Venusaur, Blastoise, Gengar, Diancie, and about twenty others) simply
 * have no entry in it. Every id below was curl-verified against
 * `https://play.pokemonshowdown.com/sprites/gen5ani/<id>.gif` before being
 * added; anything that 404'd (including `charizard-megay`, unlike its
 * `-megax` sibling) was left out rather than guessed at. Re-verify before
 * adding any new entry — a 404 falls back to no mega (see
 * `loadMegaAnimation`), so a wrong id here just means that one species
 * quietly never mega-evolves, not a crash.
 */
import type { DexEntry } from './dexData';
import { speciesEntry } from './dexData';
import type { PokemonAnimation } from './showdownArt';
import { loadRawFrameSets } from './lazySprites';

/** Species id -> its mega form sprite id(s). A single-entry array is the
 *  common case; two entries (X/Y) only for Charizard and Mewtwo, the only
 *  Kalos-split forms gen5ani actually has both halves of. */
const MEGA_FORMS: Readonly<Record<string, readonly string[]>> = {
  charizard: ['charizard-megax'],
  mewtwo: ['mewtwo-megax', 'mewtwo-megay'],
  alakazam: ['alakazam-mega'],
  ampharos: ['ampharos-mega'],
  scizor: ['scizor-mega'],
  tyranitar: ['tyranitar-mega'],
  blaziken: ['blaziken-mega'],
  gardevoir: ['gardevoir-mega'],
  mawile: ['mawile-mega'],
  medicham: ['medicham-mega'],
  manectric: ['manectric-mega'],
  banette: ['banette-mega'],
  absol: ['absol-mega'],
  garchomp: ['garchomp-mega'],
  lucario: ['lucario-mega'],
  abomasnow: ['abomasnow-mega'],
  beedrill: ['beedrill-mega'],
  steelix: ['steelix-mega'],
  glalie: ['glalie-mega'],
  salamence: ['salamence-mega'],
  latias: ['latias-mega'],
  latios: ['latios-mega'],
  rayquaza: ['rayquaza-mega']
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
  if (forms.length === 1) return forms[0];
  return forms[hashString(battleKey) % forms.length];
}

/** Build the mega form's PokemonAnimation by fetching its gen5ani sheet(s)
 *  through the same lazy-sprite pipeline every other runtime-loaded species
 *  uses (`loadRawFrameSets` — shiny falls back to normal on a 404, which
 *  then falls back to no mega at all if THAT 404s too, same as any other
 *  lazy pick). The mega id has no DexEntry of its own (it's not a real
 *  picker species), so dex/line/stage/evolvesTo are borrowed from the BASE
 *  species purely for bookkeeping — nothing reads them while a temporary
 *  form is showing (see Walker.setTemporaryForm). */
export async function loadMegaAnimation(baseId: string, megaId: string, shiny: boolean): Promise<PokemonAnimation | null> {
  const frames = await loadRawFrameSets(megaId, shiny);
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
