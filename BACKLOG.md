# backlog

Working list of known issues and planned work — open items only; completed work moves to [CHANGELOG.md](CHANGELOG.md). Rule of engagement: ship the release in flight first, then resolve items **one at a time** (no parallel fan-outs unless explicitly requested).

## in flight (v1.1.0 release batch)

- [x] long-text overflow (dictation/paths escaping roster cards, garden bubbles, topbar; brand under traffic lights — defensive fix, needs a visual once-over)
- [x] duplicate topbar view-mode buttons (terminal vs terminal-full merged)
- [x] settings panel redesign (pixel checkboxes/slider, segmented lowercase theme picker, terse copy)
- [x] light mode themes the terminals too (live, incl. system-mode OS flips); theme toggle in topbar
- [x] default zoom one notch out (−0.5); Cmd+0 resets to it too (custom app menu)
- [x] sound icon opens mini-player popover (mute, volume, transport, search, gen filter)
- [x] peaceful-only ambient music; battle tracks (379/1376 classified) reserved for battles; manual picks always win
- [x] app icon white ring in dock (full-bleed icns; pre-Tahoe macOS now shows square corners — accepted)
- [x] background subagents not appearing in the garden (root cause: the CLI reports every subagent dispatch as an instant async launch and emits no reliable completion hook; lifecycle no longer depends on those signals)
- [x] new subagent battle lifecycle: intro fight → loser wanders its own far corner while working → final fight on completion → faints (8-min safety fallback since the CLI emits no trustworthy completion event)
- [x] garden black-screen hardening: battle update loop can no longer kill the render frame; crash vector under concurrent battles removed (not a confirmed repro of the exact report — watch for recurrence)
- [x] verified: updates never lose sessions (atomic persistence flushed before quit, `--resume` respawn, userData path pinned by app name independent of bundle churn; update check never touches state)

Then: user QA pass → `node tools/release.cjs minor` → v1.1.0.

## next up (one at a time, in rough order)

1. **"tell chikorita to do X" routing** — SHIPPED (2026-08-29, see CHANGELOG unreleased). Follow-ups worth watching: bracketed-paste first-prompt delivery is unverified against a live CLI (flagged in code — first place to look if the persona lands fragmented); a relay landing in the narrow just-spawned window before a target CLI accepts input could be lost; arceus quoting the grammar verbatim would cosmetically toast an unresolved name.

## queued phases (logged 2026-08-29 — batch per phase, dispatch after usage limits ships)

### phase A — subagent lifecycle redesign — SHIPPED (2026-08-29, see CHANGELOG unreleased). Root cause of invisible/premature-death subagents found and fixed (Stop-never-signaled + shared-loop abort). Watch next real fan-out to confirm in the wild.

### phase B — layout/visual bugs — SHIPPED (2026-08-29, see CHANGELOG unreleased): icon normalization, taller topbar, quick-settings/gear merge, chip actions folded in, ghost strip, tool-bubble overlap, zoom/pixel-font root-cause fix. Needs user visual QA on the new chrome.

### phase C — ux polish — SHIPPED (2026-08-29, see CHANGELOG unreleased): species name on roster card, visible change-pokemon action, bigger picker, exact-species swap + keep-at-stage checkbox.

### phase D — feature: mega evolution

- megas are absent from the picker (they're battle forms, not dex entries — sprite sets do include mega forms). DECIDED (2026-08-29): **trigger = during battles only** — when a completion battle starts, the MAIN agent's pokemon mega evolves for the duration of the fight if its species has a mega form (sprite availability verified against the real sprite source; species without a mega just battle normally), then reverts after the battle/victory celebration. No picker entries, no manual button, no work-based trigger. Build AFTER the phase A lifecycle redesign lands (it owns the battle flow this hooks into).

### phase F — performance & battery optimization (requested 2026-08-29; runs BEFORE the demo/showreel phase)

- macOS battery menu lists Pokeharness.app under "Using Significant Energy" (screenshot-confirmed, even in Low Power mode on AC). Dedicated optimization pass so the app runs smooth AND cheap:
  - profile first (Instruments/Activity Monitor energy impact + chrome://tracing), then fix by evidence — likely suspects: the Pixi ticker rendering the garden at full fps continuously even when nothing moves or the window is hidden; render both when occluded/minimized (Electron `browserWindow.on('hide'/'show')`, `powerMonitor`, page visibility) — pause or drop to a low tick rate when not visible and when the scene is fully idle
  - cap the garden to a sane fps (pixel art doesn't need 120hz on ProMotion displays); consider dirty-flag rendering (only render frames where something animated)
  - audit timers/polls across main+renderer (update check, counters snapshot, cost watcher, usage poller, prefetchers) for coalescing; audit xterm.js renderer choice and output flow for busy sessions
  - the splitter ResizeObserver fix (phase B/wave 1) already removes one thrash source; verify with the log
  - success criteria: app leaves the "Using Significant Energy" list during normal idle use; garden CPU near-zero when window hidden
- ties into the existing "load-test 15+ concurrent chatty sessions" item in bigger later — same measurement pass can cover both.

### phase E — focus mode — SHIPPED (2026-08-29, see CHANGELOG unreleased). Follow-up idea kept: which MD tabs (monitor/tasks/activity) deserve pokéharness equivalents someday.


## smaller known items

- **AGENT_ID env var may collide with the CLI's own (found 2026-08-29 during the battle fix, not yet acted on)**: in one hook capture, a subagent's tool-call hooks carried a different AGENT_ID value than the parent's — the CLI may set its own env var of the same name for subagent-scoped hook commands, which could misroute hook events. Investigate and, if real, rename our env var to something namespaced (e.g. POKEHARNESS_AGENT_ID).
- **battle fix live verification (2026-08-29)**: the async-completion watcher was verified against headless `claude -p` captures; still unproven on a live interactive session — whether an idling session's transcript receives a completed async task's notification promptly (vs only on next user prompt). Watch the next real fan-out; log counters (battlesStarted vs notifications) will tell.


- **per-garden backdrops (requested 2026-08-29, designs IN REVISION)**: first artifact pass rejected — themes read as recolors of the same meadow. User's direction: distinct pokemon LOCATION archetypes with different look and feel altogether ("like a cave from pokemon fire red"). Redo dispatched to an agent: different map structures (cave walls, dense forest + tall grass, shoreline, etc.), not palette swaps; same artifact URL updates in place. Then user picks 5+, then build. NOTE: user said "each new session" — assumed each new GARDEN (sessions share one garden view); still unconfirmed.
- **garden day/night cycle (requested 2026-08-29, preview artifact DELIVERED — awaiting user approval)**: the current garden should transition sunny (day) → sunset (evening) → moonlit dark (night — not very dark, full-moon-on-the-ground feel) by real local time. HARD GATE: user wants to see exactly how it looks in an artifact BEFORE any code changes — preview artifact first, build only after approval. Likely implementation once approved: a Pixi color-grade overlay layer interpolating by local time (cheap, phase-F-friendly), not new tile art.


- dock icon white ring on macOS Tahoe — IMPLEMENTED (2026-08-29), needs a real-Dock eyeball before closing: root cause was Tahoe plating any app that ships only a legacy `.icns` onto its system squircle, regardless of bleed. Fix: `build/icon/gen-tahoe-icon.mjs` builds a single-layer Icon Composer (`.icon`) document from the existing full-bleed 1024px art (persisted by `gen-icon.mjs` as `build/icon/icon-1024.png`) and compiles it with `actool` (Xcode 26.6) into a checked-in `build/Assets.car`; package.json's `mac.extraResources` copies it to `Contents/Resources/Assets.car` and `mac.extendInfo.CFBundleIconName` is set to `"PokeharnessIcon"` (matching the name compiled into the asset). `.icns` stays wired as the pre-Tahoe fallback (`CFBundleIconFile`), unchanged. Verified via `electron-builder --dir`: `Assets.car` present in `Contents/Resources` (byte-identical to the checked-in copy), `CFBundleIconName`/`CFBundleIconFile` both correct in the packaged `Info.plist`, `codesign --verify --strict --deep` clean, and `assetutil --info` shows a valid multi-scale "Icon Image" set. Went further than wiring checks: actool's own companion `.icns` byproduct (from `--include-all-app-icons`) turned out to be a red herring — it always renders our layer inset with a visible plate, regardless of the source `.icon` document, because that legacy export path bakes in its own pre-Big-Sur safe-area convention. The signal that actually matters — how Tahoe itself resolves `CFBundleIconName` — was reproduced without launching the app by pointing `Bundle(path:)` + `NSImage`/`bundle.image(forResource:)` (AppKit's own resource lookup, no process launch) at a throwaway bundle wrapping the compiled `Assets.car`: our shipped icon.json (single layer, default positioning) renders full-bleed with no plate, and an artificially scaled-down layer (control test) reproduced the exact white-plate bug through the same pipeline — confirming the test discriminates real plating from a false alarm. Still open only because no one has looked at the actual Dock on this machine yet.

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine. NOTE (2026-08-29): before building, research whether a proper product-style video can be made with an already-available AI tool or directly by claude (script + storyboard + scripted screen-capture of demo mode + ffmpeg assembly is the zero-cost baseline) — hard constraint: **free to use only, zero spend**; phase F (performance/battery) runs before this phase.
- **macOS menu bar item (requested 2026-08-29, later stage)**: a `Tray` extra in the app with a pixel-art icon in our pokemon design language (note: menu bar template images are tiny ~18-22pt and traditionally monochrome/template-style — a recognizable 1-bit pixel pokéball/sprite silhouette is the likely sweet spot; test both template and full-color). WHAT IT DOES is an open design decision — candidates to pick from when this comes up: at-a-glance agent statuses (working/idle/needs-you counts with a click-through menu per session), a mini usage-limits readout (codexbar territory — we already have the data service), quick summon/focus actions, or just show/hide the window. Decide scope before building.
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
