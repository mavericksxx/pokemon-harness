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
  session, picked when the session starts
- Walkers driven by scraping the agent's terminal output: `working` walks to a
  station and shows the tool in a bubble, `blocked` walks to the signpost with a
  pulsing `!`, `idle` wanders

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
  `assets/showdown/manifest.json` for frame geometry, per-frame durations and
  locomotion, and finds the sheets by glob. Adding a Pokemon is a PNG plus a
  manifest entry; no code change.
- **Sprite size** — `scene/garden/spriteScale.ts` normalises each species'
  native sheet height to a target height in tiles.

The tool → station mapping lives in `stations.ts` as data, so retheming the
garden is an edit there plus a new map.

## Attribution

Substantial parts of the scene engine and the PTY layer are ported from
[munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (MIT) and,
upstream of it, [shahar061/the-office](https://github.com/shahar061/the-office)
(MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md) for the file-by-file map.
