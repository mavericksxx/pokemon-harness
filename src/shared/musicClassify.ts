/** Pure title-based battle-music classifier (dependency-free, matching the
 *  rest of shared/) — the garden's ambient shuffle/auto-advance must never
 *  land on a battle track (see musicCatalog.ts's own header: the 1377-track
 *  catalog is scraped, not hand-tagged, so there's no per-track combat flag
 *  to read).
 *
 *  Title-pattern-based rather than a hand-tagged list: tuned by inspecting
 *  the actual catalog (`tools/classify-music-check.ts` prints the resulting
 *  battle/peaceful counts plus a spot-check against known titles — run it
 *  with `npx tsx tools/classify-music-check.ts` after touching this file).
 *  Ambiguous titles deliberately err toward BATTLE: a peaceful-garden false
 *  positive is just a slightly-too-intense song skipped over; a battle track
 *  misclassified as peaceful is the exact bug this exists to fix (a "Battle!
 *  (Wild Pokémon)" track turning up as garden music). */

/** Titles that trip a pattern below but are ordinary location/menu themes,
 *  not battle-adjacent — checked first, before any BATTLE_PATTERNS match. */
const PEACEFUL_OVERRIDES: readonly RegExp[] = [
  /trainers?['’]?\s*school/i, // "Trainers' School" — a schoolhouse theme
  /trainer channel/i // "Pokégear Radio - Trainer Channel"
];

/** Any one of these matching the title is enough to call it battle music. */
const BATTLE_PATTERNS: readonly RegExp[] = [
  /battle/i, // "Battle!", every battle-facility name (Tower/Dome/Frontier/
  // Royal/Arena/Maison/Subway/Factory/Pyramid/...), "Decisive/Final Battle!"
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\brival\b/i, // "Rival Appears!", "My One and Only Rival"
  /\bchampion\b/i, // champion encounter/victory themes
  /elite ?four/i,
  /gym ?leader/i,
  /\bboss\b/i, // "A Team Star Boss Appears!"
  /showdown/i,
  /spotted!/i, // "Spotted! Youngster" — pre-battle "notices you" stinger
  /\btrainers?\b/i // "A Trainer Appears", "Trainers' Eyes Meet (...)"
];

/** True if `title` reads as battle (or immediately battle-adjacent) music —
 *  see the header above for the classification philosophy. */
export function isBattleTrack(title: string): boolean {
  if (PEACEFUL_OVERRIDES.some((re) => re.test(title))) return false;
  return BATTLE_PATTERNS.some((re) => re.test(title));
}
