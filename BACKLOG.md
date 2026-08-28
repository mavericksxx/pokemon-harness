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

1. **in-app provider usage limits (codexbar-style, requested 2026-08-29)** — show session (5h) / weekly / model-specific limit bars with reset countdowns, per provider. Data reality: the limit percentages are NOT in local transcripts — they come from usage endpoints the CLIs themselves call, authenticated with the CLI's own stored credentials (claude: oauth token in keychain / `~/.claude/.credentials.json` → anthropic oauth usage endpoint; codex: `~/.codex/auth.json` → chatgpt backend usage endpoint; cursor: no clean individual endpoint known — investigate). DECIDED (2026-08-29): **opt-in, off by default** — a settings toggle enables the feature, and only while enabled does the app read the CLI's existing credential to call the usage endpoint (read-only carve-out from the "never touch oauth tokens" rule: read + call + display only; never store, proxy, refresh, or implement any sign-in; toggle off = zero credential access). Display DECIDED: small topbar chip showing the single tightest limit (e.g. `wk 60%`, color-shifting as it climbs) opening a popover "trainer card" — one section per provider, pixel HP-style bars per window, reset countdowns, cost strip below (cost-today / 30d tokens from the transcript telemetry we already parse); same popover pattern as AudioPopover/QuickSettings; chip hidden entirely while the toggle is off. Poll on open + slow background refresh; local-only like everything else. Pre-build step: investigator pins exact endpoints/response shapes for claude + codex, and whether cursor has anything usable. PRIORITIZED FIRST (user, 2026-08-29).

2. **suppress the claude statusline inside pokéharness only (requested 2026-08-29)** — the user's global `statusLine` (from `~/.claude/settings.json`) renders in our embedded terminals but duplicates what the usage panel/roster will show. Mechanism confirmed: every claude spawn already passes a generated per-session `--settings` file (hookBridge.ts `prepareSession`), and CLI-flag settings take precedence over user settings — add a `statusLine` override there (empty-output command) so suppression scopes to our sessions only; ghostty/vs code/anything reading global settings is untouched. Ship as its own toggle in settings → terminal ("hide claude statusline", off by default so nothing changes silently); only add the key when the toggle is on, so toggled-off sessions inherit the user's own statusline exactly as today. Applies on next session spawn (existing ptys keep whatever they launched with). Ships in the same wave as item 1.

3. **"tell chikorita to do X" routing** — DECIDED (2026-08-29): transport = terminal injection (arceus emits a structured directive → app types the instruction into the target session's pty, visible in that terminal, all providers); autonomy = relay-only (arceus forwards only when the user explicitly asks); persona delivery switches to MD-style first prompt (replaces `--append-system-prompt`) as part of the same work; roster context fed to arceus so he knows agent names/status. The dispatch box (`ArceusDispatchBox`) is unmounted in `TerminalDrawer` pending this — re-enable it as the assignment entry when routing lands.

## queued phases (logged 2026-08-29 — batch per phase, dispatch after usage limits ships)

### phase A — critical: subagent lifecycle correctness

- subagent's pokemon fainted and left the garden while the real subagent was STILL RUNNING (observed on v1.2.0). It did materialize this time (hardening worked) but died early — suspects: the 8-min `WANDER_SAFETY_MS` fallback expiring on a long-running subagent, or a false-positive opportunistic completion signal. Before coding: pull `~/PokemonHarness/logs/harness.log` for the repro window (battle counters + any `battle-*` entries) to see which path fired. Likely fix shape: raise/remove the wander safety for subagents whose parent session is still actively emitting PreToolUse/PostToolUse hooks (parent activity = proof the wave isn't done), rather than a bigger constant.
- battles chain back-to-back with no breathing room — a new skirmish started immediately after the previous one ended; add a cooldown between battles (per-avatar and a short global stagger) so consecutive skirmishes read as separate events.

### phase B — layout/visual bugs

- garden flickers while dragging the garden/terminal splitter — likely the Pixi canvas re-laying-out/resizing every pointer-move despite the rAF throttle; consider resizing the canvas only on release (stretch/letterbox during the drag) or freezing to a snapshot while dragging.
- topbar right-side icon group: glyphs not optically centered in their boxes, and the buttons shift position as window width/content changes — normalize every topbar icon button to one fixed box size and baseline, pin the right cluster.
- quick settings (sliders icon) sitting directly beside settings (gear) is confusing and the two are misaligned. PROPOSED: merge — drop the sliders icon; the single gear at the far right opens the quick-settings popover, whose existing "all settings…" row opens the full dialog. One entry point, no duplication.
- tool dialogue box overlaps the status dot / "!" above the sprite's head (screenshot-confirmed on meganium) — bubble must offset above or hide while a status indicator/battle alert occupies that zone (gate on `battleManager.isBattling` for the battle case).
- press-and-hold on a garden chip paints a white bar/ghost strip across the topbar under the chip row (video-confirmed) — looks like a native drag ghost or text-selection artifact on the held element; suppress with `user-select: none` + `-webkit-user-drag: none` on topbar controls and verify no draggable ancestor.
- make the topbar slightly taller (user request, 2026-08-29) so the "pokéharness" brand has breathing room and reads less squashed — do together with the icon-alignment item above; note the separate unresolved brand-squash glyph mystery in smaller items still stands (taller bar is a mitigation, not the root-cause fix).

### phase C — ux polish

- roster card shows session name + provider but not the species — add the pokemon's name (e.g. "meganium") to the card.
- "change pokemon" affordance on the roster card is too small to notice/hit — make it a proper visible action on the card.
- pokemon picker dialog reads small against the rest of the app (screenshot-confirmed) — enlarge the modal itself and make the individual species cards bigger so sprites/names are easier to see (applies to both new-session and change-pokemon uses of PokemonPicker).
- active garden chip's rename/delete are bare floating pencil/trash icons beside the chip — fold them into the chip (hover-reveal inside it, or a small menu on the active chip) so the topbar reads cleaner.

### phase D — feature: mega evolution

- megas are absent from the picker (they're battle forms, not dex entries — sprite sets do include mega forms). Design a mega mechanic rather than listing them as species; candidate triggers: sustained heavy work (temporary mega while a session runs hot), during battles, or a manual "mega evolve" action on the roster card for species that have a mega. Needs a design decision before build.

### phase E — feature: focus mode (munder-difflin command center, requested 2026-08-29)

- MD has a per-agent "focus mode": full-window command center for one agent — identity header (avatar, name, status, context %), a big terminal, tabs for other panes, a roster sidebar, and a message QUEUE composer at the bottom (type instructions that queue up and send to the agent). DECIDED (2026-08-29): this is NOT a new fourth view mode — it REPLACES the existing 'terminal' view mode (Cmd+2), upgrading today's plain drawer-maximized terminal into the command center. Same slot in ViewModeSwitcher, same shortcut, same view-mode count (three). Layout: pokemon face + name + species + status + cost/context gauges as the header, the selected session's terminal as the body, the existing bottom roster strip stays as the per-agent switcher (it already shows in 'terminal' mode — no new sidebar needed), and a message composer at the bottom that queues prompts and injects them into the pty when the session goes idle (this composer is the same terminal-injection machinery as arceus routing, next-up item 3 — build focus mode after or together with routing so the injection path is shared, not duplicated). Design pass needed on which MD tabs (monitor/tasks/activity) have pokéharness equivalents worth porting vs. skipping for v1.

## smaller known items

- "needs you" over-triggers: the CLI's idle waiting-for-input notification maps to the same badge as real permission prompts — split them (permission/questions → "needs you", plain turn-ended → "idle")
- brand "pokéharness" text reads squashed (unresolved): é glyph + CSS ruled out; two live hypotheses — the −0.5 zoom breaking Press Start 2P's pixel grid app-wide, or the topbar's `-webkit-app-region: drag` region's Electron text-rendering quirk. Discriminating test: screenshot brand + a modal h2 in one frame; if both look off it's the zoom (not `.brand`'s fault)
- "new workspace"/"delete workspace" dialog copy still says workspace under the new "+ new garden" vocabulary — align to "garden"
- invisible-subagent root cause still unconfirmed: the spawn chain is hardened + logged; on next repro check `~/PokemonHarness/logs/harness.log` for `battle-bus`/`hook-router` errors and fix the named throw

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine
- **tier-2 signed auto-update** if an Apple developer cert ($99/yr) ever makes sense
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
