# Assets

This directory contains third-party art assembled for a personal, non-commercial
fan project (Pokemon walking around a pixel-art garden).

## Pokemon fan-use disclaimer

Pokemon, all Pokemon character names, and their distinctive designs and sprites are
trademarks and copyright (c) of Nintendo, Game Freak, and Creatures Inc. The sprites in
`assets/showdown/` are fan-made rips of official game assets, used here purely as
non-commercial fan content for a personal project. No ownership is claimed over any
Pokemon character, design, or sprite. This project is not affiliated with, endorsed by,
or sponsored by Nintendo, Game Freak, Creatures Inc., or The Pokemon Company. Assets will
be removed on request from the rights holders.

## assets/pokemon/ -- REMOVED

An earlier pass shipped 32x32 HeartGold/SoulSilver overworld walk sprites here.
They were replaced by the animated Showdown sheets below and deleted, so nothing
in the app reads them any more. The history is in git if they are ever wanted:
see the commit "Add sliced HGSS Pokemon walk spritesheets and CC0/CC-BY garden
tilesets".

## assets/showdown/ -- animated battle sprites (garden pets)

- Source: Pokemon Showdown (https://play.pokemonshowdown.com/sprites/), the
  Gen-5 (Black/White style) animated battle sprite sets: `gen5ani/` (front-facing)
  and `gen5ani-back/` (back-facing). Same fan-use non-commercial disclaimer as
  above applies: these sprites are copyright (c) Nintendo, Game Freak, and
  Creatures Inc.; the Gen-5 animations themselves are the work of the
  Smogon/Pokemon Showdown community pixel artists. Used here purely as
  non-commercial fan content for a personal project, with no ownership claimed
  and no affiliation with Nintendo, Game Freak, Creatures Inc., The Pokemon
  Company, or Smogon/Pokemon Showdown. Assets will be removed on request from
  the rights holders.
- These are the pixel-art Gen-5 sprites (`gen5ani`), not the larger modern-style
  `ani/` set, to match the rest of the project's pixel aesthetic.
- Format delivered: one `<name>.png` per Pokemon at `assets/showdown/<name>.png`
  -- a horizontal spritesheet of every animation frame at the source GIF's
  native size (not scaled), laid out left-to-right, RGBA with transparency
  preserved. Back-facing versions are under `assets/showdown/back/<name>.png`
  (delivered for all 42; front and back sheets are NOT guaranteed to share the
  same frame size or frame count -- e.g. Pikachu front is 50x46/61 frames,
  back is 40x47/60 frames).
- Frames were coalesced from each animated GIF with Pillow (each output frame
  is a complete image reflecting the GIF's own disposal method between frames)
  so there is no ghosting or partial-frame artifacts. Verified: every sheet's
  pixel dimensions equal `frameWidth * frameCount` wide by `frameHeight` tall,
  every frame has non-transparent pixels (no blank frames), and a magnified
  spot check against a dark background found no white/light halo fringing on
  edges.
- `assets/showdown/manifest.json` is `{"pokemon": [...]}` (matches the shape
  `src/renderer/src/scene/garden/showdownArt.ts` already reads), one entry per
  Pokemon: dex number, evolution `line` id, 1-based `stage` within that line
  (both agree with `assets/dex/lines.json`), `evolvesTo` (name(s) of the next
  stage -- Eevee lists all seven Eeveelutions, final stages are empty),
  `locomotion` (`"fly"` for Charizard, `"levitate"` for the
  Gastly/Haunter/Gengar line, `"walk"` for everything else -- Charmander and
  Charmeleon are `"walk"`; flight is only gained at the Charizard stage),
  frame geometry (`frameWidth`/`frameHeight`/`frameCount`), per-frame
  `durations` in ms as an array with one entry per frame (matches the
  consumer's `entry.durations?.[i]`), `sourceUrl`, `image` path, and `hasBack`
  plus a nested `back` object (geometry/durations/sourceUrl/image) when a back
  sheet was delivered.
- Roster delivered (42/42 requested, full evolution lines): Pichu-Pikachu-Raichu;
  Eevee + all seven Eeveelutions (Vaporeon, Jolteon, Flareon, Espeon, Umbreon,
  Leafeon, Glaceon); Bulbasaur-Ivysaur-Venusaur; Charmander-Charmeleon-Charizard;
  Squirtle-Wartortle-Blastoise; Chikorita-Bayleef-Meganium;
  Cyndaquil-Quilava-Typhlosion; Totodile-Croconaw-Feraligatr; Psyduck-Golduck;
  Igglybuff-Jigglypuff-Wigglytuff; Gastly-Haunter-Gengar; Munchlax-Snorlax;
  Larvitar-Pupitar-Tyranitar. No 404s encountered; every front and back GIF in
  the roster fetched successfully.
- `assets/showdown/_preview.png` is a contact sheet (dex-order grid) of the
  first frame of all 42 Pokemon for a quick human eyeball check.

## assets/garden/ -- tileset

See `assets/garden/sources.md` for full per-file source URL, author, and license.
Summary:

| File | License | Author |
|---|---|---|
| kenney_tiny_town.png / kenney_tiny_town_padded.png | CC0 1.0 | Kenney (kenney.nl) |
| oga_mostly_flowers.png | CC-BY 4.0 (attribution required) | ArkyonVeil (OpenGameArt) |
| grasswater_pond_light.png / grasswater_pond_dark.png | CC0 1.0 | josehzz / antumdeluge (OpenGameArt) |

The Kenney and grasswater sheets are strict 16x16px grids, matching the map renderer's
tile size; the flowers sheet is a loose sprite collection (some elements span more than
one cell) rather than a strict grid. Together these cover grass, dirt/sand paths, trees,
bushes, wooden fences, flowers, and an animated pond/water tile.

Required attribution (for the one CC-BY file): "16x Tileset, Mostly Flowers by
ArkyonVeil (opengameart.org/content/16x-tileset-mostly-flowers), CC-BY 4.0."

## Files in this directory

- `assets/showdown/<name>.png` -- 42 animated front-facing spritesheets (see above)
- `assets/showdown/back/<name>.png` -- 42 animated back-facing spritesheets
- `assets/showdown/manifest.json` -- machine-readable per-Pokemon source/format/evolution details
- `assets/showdown/_preview.png` -- human-eyeball contact sheet
- `assets/dex/*.json` -- Gen 1-5 dex index and evolution lines (for the Phase 3 picker)
- `assets/garden/*.png` -- tileset images
- `assets/garden/sources.md` -- per-file source/license details
- `assets/ASSETS.md` -- this file
