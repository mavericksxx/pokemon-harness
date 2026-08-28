/**
 * Sanity check for musicClassify.ts's title-pattern battle classifier
 * against the real 1377-track catalog — not a hand-tagged ground truth
 * (there isn't one), just: print the resulting battle/peaceful split and
 * spot-check a handful of titles whose classification is unambiguous either
 * way. Run with `npx tsx tools/classify-music-check.ts` after touching
 * musicClassify.ts.
 */
import {
  BATTLE_CATALOG_IDS,
  BROWSABLE_TRACK_IDS,
  MUSIC_CATALOG_BY_ID,
  PEACEFUL_CATALOG_IDS
} from '../src/shared/musicCatalog';
import { isBattleTrack } from '../src/shared/musicClassify';

const total = BROWSABLE_TRACK_IDS.length;
console.log(`browsable tracks: ${total}`);
console.log(`battle:   ${BATTLE_CATALOG_IDS.length}`);
console.log(`peaceful: ${PEACEFUL_CATALOG_IDS.length}`);

const KNOWN_BATTLE = [
  'Battle! (Wild Pokémon—Johto Version)',
  'Battle! (Trainer—Johto Version)',
  'Battle! (Champion)',
  'Battle Tower',
  'Rival Appears!',
  'The Elite Four Appear!',
  'A Team Star Boss Appears!',
  "Trainers' Eyes Meet (Youngster)",
  'Showdown! (Lusamine)'
];
const KNOWN_PEACEFUL = [
  'Route 1',
  'Pallet Town',
  'Lavender Town',
  'Cynthia\'s Theme',
  "Trainers' School",
  'Pokégear Radio - Trainer Channel',
  'Pokemon Center',
  'Victory Road',
  'Route 29'
];

let ok = true;
console.log('\nknown-battle spot check:');
for (const title of KNOWN_BATTLE) {
  const got = isBattleTrack(title);
  console.log(`  ${got ? 'OK  ' : 'FAIL'} battle=${got}  "${title}"`);
  if (!got) ok = false;
}
console.log('\nknown-peaceful spot check:');
for (const title of KNOWN_PEACEFUL) {
  const got = isBattleTrack(title);
  console.log(`  ${!got ? 'OK  ' : 'FAIL'} battle=${got}  "${title}"`);
  if (got) ok = false;
}

// Per-gen peaceful availability — the ambient pool's gen-filtered fallback
// only matters if some gen has zero peaceful tracks.
const gens = new Set(BROWSABLE_TRACK_IDS.map((id) => MUSIC_CATALOG_BY_ID.get(id)!.gen));
console.log('\nper-gen peaceful/battle counts:');
for (const gen of gens) {
  const genIds = BROWSABLE_TRACK_IDS.filter((id) => MUSIC_CATALOG_BY_ID.get(id)!.gen === gen);
  const battle = genIds.filter((id) => BATTLE_CATALOG_IDS.includes(id)).length;
  console.log(`  ${gen}: ${genIds.length - battle} peaceful / ${battle} battle`);
}

if (!ok) {
  console.error('\nSPOT CHECK FAILED');
  process.exit(1);
}
console.log('\nspot check passed');
