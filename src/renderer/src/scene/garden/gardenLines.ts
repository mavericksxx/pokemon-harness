/**
 * Idle small-talk — Pokemon garden edition (Phase 8 §7).
 *
 * Pattern lifted from munder-difflin's cafeteriaLines.ts (MIT, see
 * ATTRIBUTION.md): short in-character one-liners shown as a speech bubble
 * above an idle walker. No "cast" here — a session's line/species stands in
 * for a character, so lines are generic across the whole roster rather than
 * keyed by name. Picked with Math.random(), same as this codebase's other
 * garden-flavor randomness (Walker.ts's wander target, shiny.ts's roll,
 * EvolutionCeremony.ts's particles) — no determinism constraint here to
 * preserve.
 */

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Idle chatter — nothing tool-specific, just a Pokemon killing time in the
 *  garden between stations. Kept short so it fits ToolBubble's wrap width. */
const IDLE_LINES: readonly string[] = [
  'chasing its own tail',
  'sniffing around the patch',
  'watching the pond ripple',
  'a little sleepy today',
  'stretching in the sun',
  'rustling through the grass',
  'humming to itself',
  'digging, just because',
  'napping on a warm rock',
  'chasing a butterfly',
  'sniffing the berry bushes',
  'rolling in the flowers',
  'staring at the clouds',
  'kicking up dust on the path',
  'listening for something',
  'practicing a battle pose',
  'scratching an itch',
  'sunbathing by the stump',
  'watching the water for fish',
  'poking at a mushroom'
];

/** Shown right as an idle walker sets off on a berry errand. */
const BERRY_ERRAND_LINES: readonly string[] = [
  'smells something sweet…',
  'off to the berry bush',
  'berry time!',
  'one more berry, promise',
  'snack break'
];

/** Shown on arrival, alongside the floating berry text. */
const BERRY_EATEN_LINES: readonly string[] = ['yum!', 'tasty!', 'mmm, ripe one', 'delicious'];

export function pickIdleLine(): string {
  return pick(IDLE_LINES);
}

export function pickBerryErrandLine(): string {
  return pick(BERRY_ERRAND_LINES);
}

export function pickBerryEatenLine(): string {
  return pick(BERRY_EATEN_LINES);
}
