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

## smaller known items

- "needs you" over-triggers: the CLI's idle waiting-for-input notification maps to the same badge as real permission prompts — split them (permission/questions → "needs you", plain turn-ended → "idle")
- brand "pokéharness" text reads squashed (unresolved): é glyph + CSS ruled out; two live hypotheses — the −0.5 zoom breaking Press Start 2P's pixel grid app-wide, or the topbar's `-webkit-app-region: drag` region's Electron text-rendering quirk. Discriminating test: screenshot brand + a modal h2 in one frame; if both look off it's the zoom (not `.brand`'s fault)
- tool bubble can overlap battle "!" alerts / floating move text now that it anchors at head−6 (same zone) — consider hiding the tool bubble while its session's avatar is mid-battle (gate the reconcile on `battleManager.isBattling`)
- "new workspace"/"delete workspace" dialog copy still says workspace under the new "+ new garden" vocabulary — align to "garden"
- invisible-subagent root cause still unconfirmed: the spawn chain is hardened + logged; on next repro check `~/PokemonHarness/logs/harness.log` for `battle-bus`/`hook-router` errors and fix the named throw

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine
- **tier-2 signed auto-update** if an Apple developer cert ($99/yr) ever makes sense
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
