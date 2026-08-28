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
- `assets/showdown/manifest.json` is a flat object keyed by Showdown id
  (matches the shape `src/renderer/src/scene/garden/showdownArt.ts` reads via
  `Object.values(manifest as Record<string, ManifestEntry>)`), one entry per
  Pokemon: dex number, evolution `line` id, 1-based `stage` within that line
  (both agree with `assets/dex/lines.json`), `evolvesTo` (name(s) of the next
  stage -- Eevee lists all seven Eeveelutions, final stages are empty),
  `locomotion` (`"fly"` for Charizard, `"levitate"` for the
  Gastly/Haunter/Gengar line, `"walk"` for everything else -- Charmander and
  Charmeleon are `"walk"`; flight is only gained at the Charizard stage),
  frame geometry (`frameWidth`/`frameHeight`/`frameCount`), per-frame
  `durations` in ms (a single number when uniform across all frames, else an
  array -- the consumer's `frameTime()` handles both forms), `sourceUrl`,
  `image` path, and `hasBack` plus a nested `back` object
  (geometry/durations/sourceUrl/image) when a back sheet was delivered.
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

## Runtime-fetched sprites (species beyond the bundled 42)

The full dex picker (`assets/dex/dexIndex.json` + `lines.json`, ~1025 species
-- see "Files in this directory" below) covers far more than the 42 bundled
here. Picking anything else fetches its
sprite at runtime, under the same fan-use disclaimer above (copyright
Nintendo, Game Freak, and Creatures Inc.; used purely as non-commercial fan
content, no ownership claimed, no affiliation, removed on request from the
rights holders). The app is the fetcher, not a redistributor: nothing
runtime-fetched ships in this repository or its releases.

Two art kinds, by dex number:

- **#1-649 (Gen 1-5): animated.** Same `gen5ani`/`gen5ani-back` sets as the
  bundled sheets. The main process fetches
  `https://play.pokemonshowdown.com/sprites/gen5ani/<id>.gif` (and
  `gen5ani-back/<id>.gif`), the renderer decodes the GIF and coalesces its
  frames the same way the bundled sheets were produced (each output frame
  reflecting the source GIF's own disposal method). A sheet that would exceed
  8192px wide wraps into multiple rows, recorded in the cache sidecar (below).
- **#650-1025 (Gen 6-9): static.** Showdown never drew Gen-5-style pixel art
  past Gen 5, so these use the Smogon Sprite Project's fan-made
  Gen-5-STYLE STATIC sprites instead -- one still PNG per species, no
  animation. Same fan-use disclaimer, same hosting: the main process fetches
  `https://play.pokemonshowdown.com/sprites/gen5/<id>.png` (and
  `gen5-back/<id>.png`), and the renderer wraps the single image as a 1-frame
  sheet rather than decoding a GIF -- everything downstream (the disk cache,
  `WalkerSprite`'s bob/mirror/shadow treatment) is oblivious to the
  difference; it just sees a sheet with one frame instead of many.

Either way the result is cached to
`app.getPath('userData')/sprites/<id>-front.png` /
`<id>-back.png` (plus a `.json` sidecar of frame geometry and durations) so
each species is fetched at most once per machine. A failed fetch (offline,
404 -- most species have no back sprite, which is expected and not an error)
shows a pokeball placeholder and a toast, and is not cached, so the next pick
retries.

**Sprite coverage for #650-1025** is not guaranteed complete -- the Smogon
Sprite Project is fan-drawn and its coverage of the newest species varies.
`tools/build-dex.cjs` HEAD/GET-checks every one of the 376 static-tier
species against the live site at build time and records `hasSprite: false`
in `dexIndex.json` for a confirmed 404 (a flaky result -- timeout, 429, 5xx --
is treated as "can't tell" and left `true`, so a bad network run during the
build never bakes a false negative into committed data); the picker greys
those out with a "no sprite available" hint instead of letting a pick fail
after the fact. As of the last `npm run gen:dex` run, coverage was 376/376
(100%) -- see that command's own console output for the current numbers, and
`README.md`'s "Pokemon picker" section for how the picker surfaces a miss.

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

## assets/audio/ -- music, cries, and battle SFX (Phase 7)

Same fan-use, non-commercial disclaimer as above applies to every source below:
used purely as non-commercial fan content for a personal project, no ownership
claimed, no affiliation with Nintendo, Game Freak, Creatures Inc., The Pokemon
Company, Smogon/Pokemon Showdown, khinsider, or sounds-resource.com/
BellBlitzKing. Assets will be removed on request from the rights holders.

- **Ambient/battle/ceremony music -- fetched at runtime, NOT bundled.** Source:
  khinsider (downloads.khinsider.com), the Pokemon HeartGold/SoulSilver
  soundtrack album (`pokemon-heartgold-and-soulsilver`). `src/main/musicCache.ts`
  does the two-hop fetch khinsider requires (no direct download link exists):
  the album page's `<a href>` for a given track number points at an HTML track
  page, which itself embeds the real mp3 URL at
  `nu.vgmtreasurechest.com/soundtracks/pokemon-heartgold-and-soulsilver/...`.
  Matched by track NUMBER (`"09."`, `"39."`, ...), not by title text -- several
  titles carry accents/em-dashes (`Battle! (Wild Pokémon—Johto Version)`) that
  make robust title matching far more fragile than the number every track
  filename already starts with. Tracks used: 04 New Bark Town, 09 Route 29, 13
  Cherrygrove City, 22 Violet City, 33 Azalea Town (ambient rotation); 10
  Battle! (Wild Pokemon), 18 Battle! (Trainer) (battle); 39 Evolution, 40
  Congratulations! Your Pokemon Evolved! (evolution ceremony). Cached to
  `app.getPath('userData')/audio/music/<id>.mp3` on first use, like the sprite
  cache -- fetched at most once per machine. The khinsider two-hop fetch was
  verified live (one track, end-to-end, then the rest via the same code path).
- **Cries -- fetched at runtime, NOT bundled.** Source: Pokemon Showdown
  (`https://play.pokemonshowdown.com/audio/cries/<id>.mp3`), same Showdown-style
  dex id the sprite cache already uses. Cached to
  `app.getPath('userData')/audio/cries/<id>.mp3`.
- **Battle/evolution SFX -- bundled, committed.** Source: sounds-resource.com's
  rip of the Gen 4 (Diamond/Pearl/Platinum/HGSS) attack-move sound pack, credited
  there to BellBlitzKing. The full pack (620 per-move MP3s, ~57MB) is NOT in this
  repo -- only a curated ~18-file (~1.2MB) subset lives at `assets/audio/sfx/`,
  covering the tool-to-move vocabulary in
  `src/renderer/src/audio/toolSounds.ts` plus the battle victory chime
  (`Heal_Bell.mp3`) and the evolution riser (`Growth.mp3`). Reproducible from
  the original zip with `node tools/curate-sfx.cjs /path/to/attack-move-sfx.zip`
  -- see that script for the exact file list.

## Files in this directory

- `assets/showdown/<name>.png` -- 42 animated front-facing spritesheets (see above)
- `assets/showdown/back/<name>.png` -- 42 animated back-facing spritesheets
- `assets/showdown/manifest.json` -- machine-readable per-Pokemon source/format/evolution details
- `assets/showdown/_preview.png` -- human-eyeball contact sheet
- `assets/dex/*.json` -- full #1-1025 dex index and evolution lines (for the
  picker), generated by `tools/build-dex.cjs` (`npm run gen:dex`)
- `assets/garden/*.png` -- tileset images
- `assets/garden/sources.md` -- per-file source/license details
- `assets/audio/sfx/*.mp3` -- curated battle/evolution SFX (see above); music
  and cries are fetched at runtime, not stored in this repo
- `assets/ASSETS.md` -- this file
