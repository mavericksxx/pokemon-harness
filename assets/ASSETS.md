# Assets

This directory contains third-party art assembled for a personal, non-commercial
fan project (Pokemon walking around a garden, HGSS/GBA pixel-art aesthetic).

## Pokemon fan-use disclaimer

Pokemon, all Pokemon character names, and their distinctive designs and sprites are
trademarks and copyright (c) of Nintendo, Game Freak, and Creatures Inc. The sprites in
`assets/pokemon/` are ripped fan-made rips of official game assets, used here purely as
non-commercial fan content for a personal project. No ownership is claimed over any
Pokemon character, design, or sprite. This project is not affiliated with, endorsed by,
or sponsored by Nintendo, Game Freak, Creatures Inc., or The Pokemon Company. Assets will
be removed on request from the rights holders.

## assets/pokemon/ -- overworld walk sprites

- Source: spritedatabase.net, "Pokemon HeartGold and SoulSilver" game page
  (https://spritedatabase.net/game/1735), files "Overworld Pokemon (Generation 1)"
  (https://spritedatabase.net/file/21649,
  image: https://spritedatabase.net/files/ds/1735/Sprite/Gen1Overworld.png) and
  "Overworld Pokemon (Generation 2)" (https://spritedatabase.net/file/21650,
  image: https://spritedatabase.net/files/ds/1735/Sprite/Gen2Overworld.png).
- Ripped/credited on-sheet to: "Grim" (spritedatabase.net).
- Format delivered: one PNG per Pokemon at `assets/pokemon/<name>.png`, 128x128px,
  a 4x4 grid of 32x32 frames. Row order (top to bottom): **down, left, right, up**.
  Transparent background (see "Transparency" below).
- Roster delivered (12/12 requested): bulbasaur, charmander, squirtle, pikachu,
  jigglypuff, psyduck, gengar, eevee, snorlax, chikorita, cyndaquil, totodile.
- Full details (dex numbers, exact source row per Pokemon, frame-authenticity per
  direction) are in `assets/pokemon/manifest.json`.

### Important limitation: no back/up-facing art in the source

The source sheets only contain two real camera angles per Pokemon: a front-facing
("down") walk cycle (4 authentic frames) and one side-facing pose (2 frames), which is
mirrored horizontally in the source to give the opposite side direction (confirmed
pixel-identical to a horizontal flip for all 12 delivered Pokemon). There is **no**
back/up-facing artwork anywhere in either source file.

Because of this:
- `down`, `left`, and `right` rows are authentic source frames (left/right duplicated
  from the source's 2 unique side-pose frames to fill 4 columns: pattern `[0,1,0,1]`).
- The `up` row in every delivered PNG is a **placeholder that duplicates the down row**.
  It is not real back-view art. This is called out per-Pokemon in manifest.json via
  `directions.up.authentic: false`.

If real back-view sprites are found later (e.g. from a Pokemon Essentials-style
pre-cut community pack), only the `up` row of each file needs to be replaced.

### Transparency

The source sheets use a soft cyan vignette gradient behind each sprite cell rather than
a single flat chroma-key color, so a fixed color-key would leave fringing. Transparency
was produced by flood-filling each 32x32 frame's background inward from its four
corners, which follows the gradient but stops at the sprite's hard pixel-art outline.
Verified no visible halo artifacts on any delivered frame.

### Verification performed

- Every `<name>.png` confirmed 128x128px, RGBA, with both fully-transparent (alpha=0)
  and fully-opaque (alpha=255) pixels present, and a non-empty first frame in each of
  the 4 rows.
- `assets/pokemon/_preview.png` is a contact sheet tiling the down-facing idle frame of
  all 12 delivered Pokemon for a quick human eyeball check.
- Species identity for every delivered Pokemon was confirmed by visual inspection
  against known official appearance (not just row/index arithmetic -- the source
  sheets are NOT in a simple 1:1 National Dex index order; see manifest.json source
  notes and below).
- Left/right facing direction was independently verified for all 12 species (not just
  the one used to derive the rule): every delivered PNG's `left` row faces left and
  `right` row faces right on visual inspection (snout/eye/face position).

### A note on why this took source-structure detective work

The task brief's lead for a single "Gen4Overworld.png" (~all Gen1-4 in one 522x6734
sheet) turned out to mix species from different generations in a non-dex order (e.g.
its 3rd entry was a Gen4 starter sandwiched between Gen1 Bulbasaur/Ivysaur and
Charmander), making index arithmetic unreliable. The same site hosts cleaner
per-generation files ("Overworld Pokemon (Generation 1)", "...(Generation 2)", etc.)
that are dex-ordered per generation (with one extra/duplicated block partway through
Generation 1 that shifts the index-to-dex mapping by +1 after Nidoking). All 12 target
indices were individually visually verified against known species appearance rather
than trusted from the arithmetic alone -- see `build_pokemon.py`-equivalent notes in
manifest.json.

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

- `assets/pokemon/<name>.png` -- 12 walk spritesheets (see above)
- `assets/pokemon/manifest.json` -- machine-readable per-Pokemon source/format details
- `assets/pokemon/_preview.png` -- human-eyeball contact sheet
- `assets/garden/*.png` -- tileset images
- `assets/garden/sources.md` -- per-file source/license details
- `assets/ASSETS.md` -- this file
