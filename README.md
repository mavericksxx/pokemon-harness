# pokemon-harness

A local-only, single-user desktop coding harness: your coding-agent CLI sessions
shown as Pokemon-style walkers moving around a pixel-art garden.

Everything runs on your machine. There are no accounts, no cloud, no telemetry
and no auth of any kind — the app spawns the agent CLI (`claude`, `codex`,
`cursor-agent`) from your `PATH` and you are already logged in through that CLI's
own flow.

## Phase 1 status

A running skeleton:

- Electron + React + Pixi.js garden rendered from a Tiled `.tmj` map
- PTY-backed agent sessions with an xterm terminal drawer, multiple at once
- Walkers driven by scraping the agent's terminal output: `working` walks to a
  station and shows the tool in a bubble, `blocked` walks to the signpost with a
  pulsing `!`, `idle` wanders

The map and the character sprite are **placeholders** generated in code.

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
  `src/renderer/src/scene/garden/stations.ts`. Regenerate the placeholder with
  `npm run gen:map`.
- **Textures** — `src/renderer/src/scene/garden/placeholderArt.ts` returns Pixi
  `Texture`s. Replace `buildTilesetTexture()` with a tileset PNG load and
  `buildWalkerSheet()` with a load + slice of a real 4x4 Pokemon Essentials sheet
  (rows: down, left, right, up). Nothing else in the scene changes.

The tool → station mapping lives in `stations.ts` as data, so retheming the
garden is an edit there plus a new map.

## Attribution

Substantial parts of the scene engine and the PTY layer are ported from
[munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (MIT) and,
upstream of it, [shahar061/the-office](https://github.com/shahar061/the-office)
(MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md) for the file-by-file map.
