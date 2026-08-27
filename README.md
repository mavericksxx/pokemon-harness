# pokemon-harness

A local-only, single-user desktop coding harness: your coding-agent CLI sessions
shown as Pokemon-style walkers moving around a pixel-art garden.

Everything runs on your machine. There are no accounts, no cloud, no telemetry
and no auth of any kind — the app spawns the agent CLI (`claude`, `codex`,
`cursor-agent`) from your `PATH` and you are already logged in through that CLI's
own flow.

## Status

- Electron + React + Pixi.js garden rendered from a Tiled `.tmj` map: textured
  grass, winding dirt walks, an animated pond with a sand rim and an island,
  tree canopies walkers pass behind, planting beds, fences, a signpost
- PTY-backed agent sessions with an xterm terminal drawer, multiple at once
- Walkers are Pokemon Showdown's animated Gen-5 sprites, one species per
  session, picked when the session starts — from the full 649-species Gen 1-5
  dex via search, or a free bundled species at random
- Walkers driven by scraping the agent's terminal output: `working` walks to a
  station and shows the tool in a bubble, `blocked` walks to the signpost with a
  pulsing `!`, `idle` wanders
- Walkers face the way they're walking: predominantly-upward movement swaps to
  the species' back sheet (bundled or lazily fetched), front otherwise
- Sessions evolve as their agent works: accumulated `working` time crosses
  thresholds and the walker plays a flash/pulse/sparkle animation into its
  line's next stage, gaining whatever locomotion that stage has (e.g.
  Charizard/Gyarados can fly and cross the pond)

## Evolution

A session always hatches at its picked line's base stage (picking Gengar in
the dialog starts you with Gastly, which evolves into Gengar on its own).
Only time spent in `working` status counts toward the thresholds — idle,
blocked, and wall-clock time do not. Branching lines (Eevee) evolve into a
random member of the next stage.

Defaults: 10 minutes of working time to reach stage 2, 30 minutes to reach
stage 3. Override for testing/demos with the `POKE_EVOLVE_SECONDS` environment
variable, `"<stage2>,<stage3>"` in seconds, set on the process that launches
Electron:

```sh
POKE_EVOLVE_SECONDS=20,60 npm run dev
```

Evolving plays a ~9s ceremony (flash-in, silhouette, an accelerating
old/new-form oscillation, a lock, a flash-out reveal) modeled on the games'
own. A third, optional value scales its real-time speed (authored timings
assume `1.0` ≈ 15s; the default is `0.6`) — useful for slowing it down enough
to catch a screenshot mid-effect:

```sh
POKE_EVOLVE_SECONDS=20,60,3 npm run dev
```

## Pokemon picker

The "Pokemon" field in the New Session dialog is a type-ahead search over all
649 Gen 1-5 species by name or dex number (empty search shows the 42 bundled
species, which need no network). Uniqueness is per evolution **line**: picking
any stage of a line that's already out in the garden is greyed out. Picking a
non-base stage shows an inline note ("Gengar joins as Gastly — it'll evolve as
your agent works (Gastly → Haunter → Gengar)"); base-stage picks show the same
chain without the caveat.

Species outside the bundled 42 are fetched on demand from Pokemon Showdown at
runtime (see `assets/ASSETS.md`) and cached to disk under
`app.getPath('userData')/sprites/`, so each species is fetched at most once
ever, from any machine running the app. A fetch failure (offline, 404) falls
back to a pokeball placeholder plus a dismissible toast, and retries on the
next pick rather than remembering the failure.

## Running

```sh
npm install     # includes electron-rebuild for node-pty
npm run dev
npm run typecheck
```

macOS (Apple Silicon) is the target platform.

## Swapping in real art

Both art seams are pure data changes:

- **Map** — `src/renderer/src/scene/garden/maps/garden.tmj` is a standard Tiled
  map using the layer convention `floor`, `walls`, `furniture-below`,
  `furniture-above`, `collision` (tile layers) plus `spawn-points` and `zones`
  (object groups), 16px tiles. Replace it with a real Tiled export that keeps the
  same layer names and the spawn-point names in
  `src/renderer/src/scene/garden/stations.ts`. Regenerate it with
  `npm run gen:map` (`tools/gen-garden-map.cjs`), which reads its tileset
  geometry from `maps/gardenTilesets.json` — the same file the runtime loads
  images from, so map gids can never drift from the painter.
- **Tilesets** — `scene/garden/gardenArt.ts` loads the sheets listed in
  `maps/gardenTilesets.json`, in that order. A new sheet is an entry there plus
  an import line.
- **Pokemon** — `scene/garden/showdownArt.ts` reads
  `assets/showdown/manifest.json` for frame geometry, per-frame durations,
  locomotion and evolution data (line/stage/evolvesTo), and finds the front and
  back sheets by glob. Adding a Pokemon is a PNG plus a manifest entry; no code
  change.
- **Sprite size** — `scene/garden/spriteScale.ts` normalises each species'
  native sheet height to a target height in tiles (`TILE_HEIGHT_OVERRIDES` for
  a species that lands wrong).
- **Full dex / evolution** — `scene/garden/dexData.ts` reads
  `assets/dex/dexIndex.json` and `lines.json` for the 649-species search and
  line/stage/evolvesTo beyond the bundled 42; `scene/garden/lazySprites.ts`
  fetches and decodes art for anything not bundled.

The tool → station mapping lives in `stations.ts` as data, so retheming the
garden is an edit there plus a new map.

## Attribution

Substantial parts of the scene engine and the PTY layer are ported from
[munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (MIT) and,
upstream of it, [shahar061/the-office](https://github.com/shahar061/the-office)
(MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md) for the file-by-file map.
