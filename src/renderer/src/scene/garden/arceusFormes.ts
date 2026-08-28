/**
 * Arceus's 17 Judgment-plate formes (Phase 8.8 §3 revision) — Showdown's
 * gen5ani CDN hosts one animated sprite PER type forme (`arceus-fire.gif`,
 * `arceus-water.gif`, ...), each with the golden wheel (and a subtle body
 * tint) recolored for that type. These go through the SAME lazy sprite-fetch
 * path as any picker species (lazySprites.ts / PokemonFace.tsx) — `arceus-
 * fire` isn't a real dex entry, but `loadLazyThumbnail`/`fetchSpriteGif`
 * never require one (they only special-case `speciesEntry(id)?.static`,
 * which is safely `undefined` — i.e. "animated" — for an unknown id).
 * Verified live: every URL below 200s from `play.pokemonshowdown.com`.
 *
 * Same 17-type order as the roster card's `--plate-color` cycle
 * (index.css) — no Normal forme, since Arceus's own base form already IS
 * Normal-type and needs no plate.
 */
export const ARCEUS_FORMES: readonly string[] = [
  'arceus-fire',
  'arceus-water',
  'arceus-electric',
  'arceus-grass',
  'arceus-ice',
  'arceus-fighting',
  'arceus-poison',
  'arceus-ground',
  'arceus-flying',
  'arceus-psychic',
  'arceus-bug',
  'arceus-rock',
  'arceus-ghost',
  'arceus-dragon',
  'arceus-dark',
  'arceus-steel',
  'arceus-fairy'
];

/** How long each forme holds before cycling to the next, ms. */
export const ARCEUS_FORME_HOLD_MS = 3500;
