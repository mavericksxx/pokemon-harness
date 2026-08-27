# Garden tileset sources

The Kenney and grasswater sheets are strict 16x16px grids (matches the map renderer's
tile size). The flowers sheet is a loose sprite collection, not a strict grid -- see its
entry below.

## kenney_tiny_town.png (+ kenney_tiny_town_padded.png)
- Source: https://kenney.nl/assets/tiny-town
- Direct download used: https://kenney.nl/media/pages/assets/tiny-town/a415fbeb49-1735736916/kenney_tiny-town.zip
- Author: Kenney (kenney.nl)
- License: CC0 1.0 (public domain). "This content is free to use in personal, educational
  and commercial projects. Written permission not required, support us by crediting or
  donating (voluntary)."
- Contents used: grass, dirt/sand paths, trees and bushes (green + autumn variants), wooden
  fences, plus assorted building/wall tiles from the same sheet.
- `kenney_tiny_town.png` is the packed variant (192x176, tiles flush against each other,
  no gutters -- easiest to slice programmatically). `kenney_tiny_town_padded.png` is the
  original tilemap.png (203x186) with 1px gutters between tiles, kept in case the renderer
  prefers gutters to avoid texture bleeding.
- Grid: 16x16 tiles, 12 columns x 11 rows (132 tiles total). See original Tilesheet.txt
  layout convention (not copied here, but same tile order as Kenney's standard Tiny series).

## oga_mostly_flowers.png
- Source: https://opengameart.org/content/16x-tileset-mostly-flowers
- Direct file: https://opengameart.org/sites/default/files/tilemap_10.png
- Author: ArkyonVeil (https://opengameart.org/users/arkyonveil)
- License: CC-BY 4.0 -- attribution required. Credit as: "16x Tileset, Mostly Flowers by
  ArkyonVeil (opengameart.org/content/16x-tileset-mostly-flowers), CC-BY 4.0."
- Contents used: flowers (many colors, seed-to-bloom growth stages), grass tufts, a small
  pond/water sample, ground variations, rocks, and a tree in various growth/health states.
- Note: this sheet is a loose sprite collection rather than a strict uniform grid (some
  elements, like the tree and tall flowers, span more than one 16px cell). Slice
  individual elements as needed rather than treating the whole file as a fixed grid.

## grasswater_pond_light.png / grasswater_pond_dark.png
- Source: https://opengameart.org/content/grasswater-16x16-tiles
- Direct file(s): https://opengameart.org/sites/default/files/Grass%26WaterTileset_0.zip
  (contains both Grass&Water_Light.png and Grass&Water_Dark.png, renamed here to
  grasswater_pond_light.png / grasswater_pond_dark.png)
- Author: josehzz / antumdeluge (https://opengameart.org/users/josehzz,
  https://opengameart.org/users/antumdeluge)
- License: CC0 1.0 (public domain). "Can be used for personal and commercial projects.
  Credit (link to the OGA page) appreciated but not required."
- Contents: animated grass/water pond edges, 16x16 tiles, 8 animation frames per sheet
  (176x128 per frame block per the pack's README; delivered files are 704x256 sheets).
  Use this as the pond/water tile source.

## Not used
- The Liberated Pixel Cup (LPC) base assets and other 32x32 CC-BY-SA/GPL packs mentioned
  as a fallback lead were not needed since the CC0/CC-BY 16x16 sources above already cover
  grass, flowers, trees, bushes, paths, pond/water, and fences.
