# Attribution

pokemon-harness ports several files from prior MIT-licensed work. Those files
keep an attribution header in-source; this document is the index.

## munder-difflin

- Repository: <https://github.com/chaitanyagiri/munder-difflin> (v0.4.6)
- Author: Chaitanya Giri
- License: MIT

Most of the engine below was taken from munder-difflin rather than rewritten.
Where munder-difflin itself credits an upstream, that credit is carried forward.

## shahar061/the-office

- Repository: <https://github.com/shahar061/the-office>
- License: MIT

munder-difflin's office scene (tile renderer, pathfinding, camera, seat pool,
character sprite, tool bubble) derives from the-office. Our garden scene derives
from munder-difflin's, so the-office is upstream of it too.

## Bundled fonts

- Press Start 2P, Inter, and JetBrains Mono ship inside the app bundle at
  `src/renderer/src/assets/fonts/` (latin subsets, woff2). All three are free
  and OFL-1.1 licensed — full license text and per-file copyright travels
  with them at `src/renderer/src/assets/fonts/LICENSE.txt`, as the OFL
  requires. None of the three fonts is otherwise derived from munder-difflin
  or the-office; the *pattern* of self-hosting them via `fonts.css` is (see
  the file map below).

## File map

| File in this repo | Derived from | Nature of the port |
| --- | --- | --- |
| `src/renderer/src/scene/garden/pathfinding.ts` | munder-difflin `scene/office/pathfinding.ts` → the-office `office/engine/pathfinding.ts` | verbatim, plus an optional `canEnter` predicate so fliers can cross water |
| `src/renderer/src/scene/garden/SeatPool.ts` | munder-difflin `scene/office/SeatPool.ts` → the-office `office/SeatPool.ts` | verbatim |
| `src/renderer/src/scene/garden/Camera.ts` | munder-difflin `scene/office/Camera.ts` → the-office `office/engine/camera.ts` | near-verbatim; dropped `nudgeToward` |
| `src/renderer/src/scene/garden/TiledMapRenderer.ts` | munder-difflin `scene/office/TiledMapRenderer.ts` → the-office `office/engine/TiledMapRenderer.ts` | near-verbatim; garden station names in `WALKABLE_SPAWN_PREFIXES`, added a painted-sprite count, character layer moved under `furniture-above`, added Tiled tile animations and a `water` mask layer |
| `src/renderer/src/scene/garden/ToolBubble.ts` | munder-difflin `scene/office/ToolBubble.ts` → the-office `office/characters/ToolBubble.ts` | near-verbatim; recolored, trimmed icon map |
| `src/renderer/src/scene/garden/WalkerSprite.ts` | munder-difflin `scene/office/CharacterSprite.ts` → the-office `office/characters/CharacterSprite.ts` | contract only (feet-origin container, setPosition/destroy). Rewritten inside for Showdown idle animations: one loop, mirrored facing, drop shadow, bob |
| `src/renderer/src/scene/garden/Walker.ts` | munder-difflin `scene/office/Character.ts` → the-office `office/characters/Character.ts` | heavily slimmed: kept the BFS path-follow loop, its tile/pixel convention and the wander behaviour; facing is now a mirror, and locomotion decides water crossing |
| `src/renderer/src/pty/ansiText.ts` | munder-difflin `components/ansiText.ts` | verbatim |
| `src/renderer/src/pty/ptyParser.ts` | munder-difflin `hooks/usePtyParser.ts` | same regexes and idle heuristic; converted from a React hook to a plain factory, god/sub-agent split and context sniffing dropped |
| `src/main/pty.ts` | munder-difflin `main/pty.ts` | trimmed: kept command resolution, the session identity guard and the per-id IPC channels; dropped all Windows paths, hive env injection and multi-window routing |
| `src/main/shellEnv.ts` | munder-difflin `main/shellEnv.ts` | trimmed to macOS/Linux |
| `tools/ensure-pty-perms.cjs` | munder-difflin `tools/ensure-pty-perms.cjs` | verbatim |
| `src/shared/agentProvider.ts` | munder-difflin `shared/agentProvider.ts` | shape only: three providers, none of the hive/bridge machinery |
| Pixi init settings in `scene/garden/GardenScene.tsx` | munder-difflin `scene/office/OfficeFloor.tsx` | the pixel-art render settings (`antialias: false`, `roundPixels`, resolution floor of 2, `autoDensity`) |
| Tiled layer convention (`floor`, `walls`, `furniture-below`, `furniture-above`, `collision`, `spawn-points`, `zones`) | munder-difflin / the-office | convention adopted as-is |

| `src/renderer/src/design/tokens.ts` | munder-difflin `design/tokens.ts` + shipped `design/tokens.css` (post-v0.3.4 recalibration) | structure AND values: neutral ground ramp, session accents, status colors, 4px space scale, type scale, hard-shadow panel language, all mirrored onto `:root` as CSS custom properties by `applyTokens()` |
| `src/renderer/src/design/fonts.css` | munder-difflin `design/fonts.css` | pattern only (three self-hosted `@font-face` rules, latin subsets); the font files themselves are separately-licensed third-party assets, see below |

Written fresh for this project (no upstream): `tools/gen-garden-map.cjs`,
`tools/build-dex.cjs`,
`scene/garden/gardenArt.ts`, `scene/garden/showdownArt.ts`,
`scene/garden/spriteScale.ts`, `scene/garden/imageTexture.ts`,
`scene/garden/stations.ts`,
`scene/garden/GardenScene.tsx` (structure), `pty/terminalRegistry.ts`,
`store/store.ts`, `sessions.ts`, all React components, `src/main/index.ts`,
`src/preload/*`.
