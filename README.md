# Pokéharness

A local-only, single-user desktop coding harness: your coding-agent CLI sessions
shown as Pokemon-style walkers moving around a pixel-art garden.

Everything runs on your machine. There are no accounts, no cloud, no telemetry
and no auth of any kind — the app spawns the agent CLI (`claude`, `codex`,
`cursor-agent`) from your `PATH` and you are already logged in through that CLI's
own flow.

## Install

**Download a release** (macOS, Apple Silicon): grab the latest `.zip` from
[Releases](https://github.com/mavericksxx/pokemon-harness/releases), unzip it,
and drag `Pokéharness.app` to `/Applications`. Builds are ad-hoc signed (no
paid Apple Developer ID behind this project), so macOS Gatekeeper will refuse
a plain double-click the first time with an "unidentified developer" warning
— **right-click (or Control-click) the app → Open → Open** instead, once.
After that first launch it opens normally like anything else.

**Run from source** (any platform you can get `node-pty` building on):

```sh
git clone https://github.com/mavericksxx/pokemon-harness.git
cd pokemon-harness
npm install     # includes electron-rebuild for node-pty
npm run dev
```

Either way, the app itself is stateless setup — it spawns whichever agent CLI
(`claude`, `codex`, `cursor-agent`) you already have installed and authenticated
on your `PATH`; there's no separate account or login inside the app.

## Status

- Electron + React + Pixi.js garden rendered from a Tiled `.tmj` map: textured
  grass, winding dirt walks, an animated pond with a sand rim and an island,
  tree canopies walkers pass behind, planting beds, fences, a signpost
- PTY-backed agent sessions with an xterm terminal drawer, multiple at once
- Walkers are Pokemon Showdown's animated Gen-5 sprites (Gen 1-5, #1-649) or,
  for Gen 6-9 (#650-1025), the Smogon Sprite Project's fan-made static
  Gen-5-style sprites — one species per session, picked when the session
  starts from the full ~1025-species dex via search, or a free bundled
  (always animated) species at random
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
blocked, and wall-clock time do not. Branching lines (Eevee, Scyther, ...)
evolve into a random member of the next stage.

**Static (Gen 6-9, #650-1025) species only enter the garden by manual pick,
never at random.** This applies at every random-selection point: the picker's
random default only draws from the bundled 42 (all animated already, so
nothing to filter), and a branching evolution's random draw
(`randomAnimatedSpecies` in `dexData.ts`) excludes static targets before
picking — Eevee's random branch pool is Vaporeon...Glaceon, never Sylveon; if
every branch option is static, the line just stops evolving there. A
*linear* (non-branching) evolution is not a random pick at all, so it always
proceeds even into a static target once reached — Bisharp still evolves into
Kingambit on schedule. Either way, the static species is only reachable in
the first place because someone picked its line manually; the automatic
evolution is completing a choice already made, not making a new one.

One consequence worth knowing: the picker's inline chain note (below) lists
every branch a line's data says exists, including static ones — e.g. Eevee's
note still says "...or Sylveon" and Scyther's says "...or Kleavor" — but the
random draw above will never land on that branch on its own. Reaching Sylveon
or Kleavor means picking them directly from the search results, not letting
Eevee or Scyther evolve unattended.

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

## Shiny Pokemon

Every session rolls shiny once, at creation, with default odds 1-in-64 —
independent of species, and kept for the session's whole lifetime, through
every evolution stage. Override for testing/demos with the `POKE_SHINY_ODDS`
environment variable (1-in-N; `1` means always shiny), set on the process
that launches Electron:

```sh
POKE_SHINY_ODDS=1 npm run dev
```

A shiny walker's first garden spawn plays a sparkle burst (a ring of 4-6
twinkling white/gold stars) and a floating "✨ Shiny!"; a small ★ badge marks
it on its session tab and, if that line is already taken, in the picker.
Showdown/Smogon ship no shiny sheets for the 42 bundled species, so a shiny
pick always fetches its sprite lazily — front and back, animated or static —
even for an otherwise-bundled species; a 404'd shiny front sheet falls back
to the normal sprite (logged), keeping the shiny flag and badge either way.
Wild subagent-battle challengers (below) roll shiny with the same odds and
get the same spawn sparkle.

## Claude Code hooks (authoritative session state)

For `claude` sessions specifically, the app wires Claude Code's lifecycle
hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `Stop`, `SubagentStop`) instead of relying solely on scraping
terminal text. On spawn, main writes a per-session `settings.json` (a temp
file, never touching your own `~/.claude/settings.json`) whose `hooks` block
runs a small generated shim (`<userData>/hooks-bin/cth-hook.cjs`, invoked
through a bundled-node launcher so it works even when `node` isn't on the
stripped `PATH` Claude runs hooks with). The shim forwards each hook's JSON
payload over a Unix domain socket to the main process
(`src/main/hookBridge.ts`), which relays it to the renderer over
`hooks:event:<sessionId>` IPC.

**Hooks are authoritative once they start flowing** for a session — the
renderer's hook router (`src/renderer/src/pty/hookRouter.ts`) drives
status/tool/station directly from hook events, and the regex parser
(`ptyParser.ts`) steps aside for that session. This is a *latch*, not a
short window: once a session's first hook fires, the regex parser stays out
of the way for the rest of that session's life unless hooks go quiet for 60
seconds straight (an old Claude Code version without hook support, or a
session that otherwise never fires one) — at which point the regex parser
resumes as a safety net.

**Fallback to the regex parser** happens automatically for:
- Non-`claude` providers (`codex`, `cursor-agent`) — hooks are Claude Code
  -specific, so these are always regex-driven, exactly as before.
- A `claude` session whose hooks have gone silent for 60+ seconds (see above).

The app never gates or denies a tool call at the hook boundary — hooks here
are observation-only, purely for state (no HITL/permission logic).

*Real-`claude` verification is pending a manual user test.* Everything above
was verified end-to-end by spawning a real session with a harmless long-lived
command in place of `claude` (so main still wires the real hook
settings/env) and invoking the generated shim directly with hand-written
fake hook JSON on stdin — i.e. exercising the exact shim → socket → main →
IPC → renderer path a real `claude` process would, without a real `claude`
binary in the loop.

## Subagent battles

When a `claude` session's hooks (or, as a fallback, its terminal output —
` ● Task(` lines) show a `Task` tool call, the garden treats it as a
subagent spawn: a random ANIMATED Pokemon (excluding lines already in use by
a session or another battler, preferring bundled base-stage species) poofs
in far from the parent, a "!" pops over both its head and the parent's, and
then both walk toward each other and square off — the parent bottom-left on
its back sheet, the challenger top-right on its front sheet, gen5ani's own
native draw angles aiming them at each other with no mirroring needed. While
the subagent is active, the parent's own tool calls become alternating
attacks (lunge, hit-flash, floating "«Species» used «Tool»!" text); rapid
tool events coalesce into the current attack's combo counter instead of
queuing replays. Up to 3 concurrent subagents fan out around the parent
(more show as a "+N" badge); `SubagentStop` (or the parent going idle, in
regex-fallback mode) ends one with a poof, and the last one ending plays a
victory hop before the garden returns to normal. An evolution ceremony
triggered mid-battle waits for the current attack to finish, then runs to
completion before the battle resumes — the ceremony's own exclusivity is
never touched by the battle code.

## Pokemon picker

The "Pokemon" field in the New Session dialog is a type-ahead search over the
full #1-1025 dex by name or dex number (empty search shows the 42 bundled
species, which need no network). Uniqueness is per evolution **line**: picking
any stage of a line that's already out in the garden is greyed out. Picking a
non-base stage shows an inline note ("Gengar joins as Gastly — it'll evolve as
your agent works (Gastly → Haunter → Gengar)"); base-stage picks show the same
chain without the caveat. Un-truncated chains now cross the old Gen-5 cutoff
too — e.g. searching Kingambit shows "Kingambit joins as Pawniard".

Gen 6-9 (#650-1025) results carry a small "static sprite" tag, since those
species use a still image rather than the Gen 1-5 lines' idle animation (see
`assets/ASSETS.md`). A species the Smogon Sprite Project has no art for shows
greyed out with a "no sprite available" tooltip instead of a pickable option —
`tools/build-dex.cjs` records that per-species as `hasSprite: false` from a
build-time coverage sweep, so a bad pick can't fail after the fact.

Species outside the bundled 42 are fetched on demand from Pokemon Showdown (or,
for statics, the Smogon Sprite Project via the same Showdown-hosted mirror) at
runtime and cached to disk under `app.getPath('userData')/sprites/`, so each
species is fetched at most once ever, from any machine running the app. A
fetch failure (offline, 404) falls back to a pokeball placeholder plus a
dismissible toast, and retries on the next pick rather than remembering the
failure.

## Audio

A speaker icon in the top bar opens a compact popover: a master mute, a
Music toggle + volume slider, and an SFX toggle + volume slider. All five
settings persist across relaunch (`app.getPath('userData')/audio-settings.json`).
**Music is OFF by default** on first run (so it doesn't start playing
unannounced); **SFX is ON by default**.

Music tracks are HeartGold/SoulSilver OST clips, fetched from khinsider the
first time you turn Music on (never bundled — see `assets/ASSETS.md` for the
two-hop fetch this needs) and cached to disk after that. The popover shows
"downloading music… (n/9)" while that first fetch is in flight; if it's
offline, Music shows "unavailable offline" and switches itself back off
rather than silently doing nothing. Once ready: an ambient track plays on a
shuffled, no-immediate-repeat rotation with a ~2.5s crossfade between songs;
any battle crossfades to a battle track for as long as at least one battle is
active (overlapping battles share one track); an evolution ceremony
crossfades to a charge loop for the oscillation phases and a short fanfare at
the flash/reveal, then hands the bus back to whichever of battle/ambient was
playing underneath — never unconditionally back to ambient, so a ceremony
mid-battle doesn't cut that battle's music.

SFX (independent of the Music toggle) covers: a species' cry on its walker's
first spawn and again at an evolution's reveal (also fetched-and-cached, from
Pokemon Showdown); a per-tool "move" sound on each battle attack (Read/Grep
scratch/peck, Edit/Write a Cut, Bash a punch, WebFetch/WebSearch a
Gust/Whirlwind, Task a Teleport, anything else a generic hit — see
`src/renderer/src/audio/toolSounds.ts`); a victory chime; and a soft riser at
evolution ceremony start. These clips are a small curated, committed subset
(not fetched) — see `assets/ASSETS.md`.

## Development

Same `git clone` + `npm install` as the "Run from source" step above, then:

```sh
npm run dev         # electron-vite dev, hot-reloads renderer changes
npm run typecheck   # tsc --noEmit, node + web configs
npm run build        # electron-vite build (production bundle, no packaging)
npm run dist         # npm run build + electron-builder — packaged, ad-hoc-signed .app zip
npm run gen:icon     # regenerates build/icon.icns + build/icon/icon.png from build/icon/gen-icon.mjs
npm run release      # bumps version, builds, prints (never auto-runs) the gh release command
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
  `assets/dex/dexIndex.json` and `lines.json` for the full #1-1025 search and
  line/stage/evolvesTo/locomotion beyond the bundled 42, generated by
  `tools/build-dex.cjs` (`npm run gen:dex`) from Pokemon Showdown's own dex
  data; `scene/garden/lazySprites.ts` fetches and decodes art for anything
  not bundled — an animated sheet for #1-649, a single static frame for
  #650-1025.

The tool → station mapping lives in `stations.ts` as data, so retheming the
garden is an edit there plus a new map.

## Attribution

Substantial parts of the scene engine and the PTY layer are ported from
[munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (MIT) and,
upstream of it, [shahar061/the-office](https://github.com/shahar061/the-office)
(MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md) for the file-by-file map.

## Fan-use notice

Pokémon and Pokémon character names are trademarks of Nintendo, Game Freak,
and Creatures Inc. Walker sprites are drawn from
[Pokémon Showdown](https://pokemonshowdown.com/)'s animated Gen-5 sheets and
the [Smogon Sprite Project](https://www.smogon.com/forums/threads/smogon-sprite-project.3647722/)'s
fan-made static sheets for species Showdown doesn't animate; cries and music
are fetched at runtime from Showdown and [khinsider](https://downloads.khinsider.com/)
respectively (see `assets/ASSETS.md` for exactly what's fetched vs. bundled).
None of this artwork or audio is included in this repository's own license —
it's pulled from those sources on demand, cached locally, and used here purely
as a personal, non-commercial fan project with no affiliation to Nintendo,
Game Freak, Creatures Inc., Pokémon Showdown, Smogon, or khinsider. If you're
a rights holder and want anything here changed or removed, open an issue and
it'll be handled promptly.
