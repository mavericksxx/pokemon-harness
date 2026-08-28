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



1. **"tell chikorita to do X" routing** (IN FLIGHT — wave-1 agent building it now) — DECIDED (2026-08-29): transport = terminal injection (arceus emits a structured directive → app types the instruction into the target session's pty, visible in that terminal, all providers); autonomy = relay-only (arceus forwards only when the user explicitly asks); persona delivery switches to MD-style first prompt (replaces `--append-system-prompt`) as part of the same work; roster context fed to arceus so he knows agent names/status. The dispatch box (`ArceusDispatchBox`) is unmounted in `TerminalDrawer` pending this — re-enable it as the assignment entry when routing lands.

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

### phase E — feature: focus mode (munder-difflin command center, requested 2026-08-29)

- MD has a per-agent "focus mode": full-window command center for one agent — identity header (avatar, name, status, context %), a big terminal, tabs for other panes, a roster sidebar, and a message QUEUE composer at the bottom (type instructions that queue up and send to the agent). DECIDED (2026-08-29): this is NOT a new fourth view mode — it REPLACES the existing 'terminal' view mode (Cmd+2), upgrading today's plain drawer-maximized terminal into the command center. Same slot in ViewModeSwitcher, same shortcut, same view-mode count (three). Layout: pokemon face + name + species + status + cost/context gauges as the header, the selected session's terminal as the body, the existing bottom roster strip stays as the per-agent switcher (it already shows in 'terminal' mode — no new sidebar needed), and a message composer at the bottom that queues prompts and injects them into the pty when the session goes idle (this composer is the same terminal-injection machinery as arceus routing, next-up item 3 — build focus mode after or together with routing so the injection path is shared, not duplicated). Design pass needed on which MD tabs (monitor/tasks/activity) have pokéharness equivalents worth porting vs. skipping for v1.

## smaller known items

- dock icon white ring RETURNED on macOS Tahoe (2026-08-29, dispatched): the shipped icns IS full-bleed (all corners verified opaque in the installed v1.2.0 bundle), so the v1.1.0 fix works as far as icns can — the remaining ring is Tahoe PLATING legacy-icns-only apps onto the system's light squircle regardless of bleed. Real fix: ship a compiled Icon Composer asset (`Assets.car` + `CFBundleIconName` in Info.plist) alongside the icns fallback; `actool` from Xcode 26.6 is available on the build machine.

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine. NOTE (2026-08-29): before building, research whether a proper product-style video can be made with an already-available AI tool or directly by claude (script + storyboard + scripted screen-capture of demo mode + ffmpeg assembly is the zero-cost baseline) — hard constraint: **free to use only, zero spend**; phase F (performance/battery) runs before this phase.
- **tier-2 signed auto-update** if an Apple developer cert ($99/yr) ever makes sense
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
