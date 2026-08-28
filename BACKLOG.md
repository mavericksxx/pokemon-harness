# backlog

Working list of known issues and planned work — open items only; completed work moves to [CHANGELOG.md](CHANGELOG.md). Rule of engagement: ship the release in flight first, then resolve items **one at a time** (no parallel fan-outs unless explicitly requested).

## in flight (v1.1.0 release batch)

- [x] long-text overflow (dictation/paths escaping roster cards, garden bubbles, topbar; brand under traffic lights — defensive fix, needs a visual once-over)
- [x] duplicate topbar view-mode buttons (terminal vs terminal-full merged)
- [x] settings panel redesign (pixel checkboxes/slider, segmented lowercase theme picker, terse copy)
- [x] light mode themes the terminals too (live, incl. system-mode OS flips); theme toggle in topbar
- [x] default zoom one notch out (−0.5) — note: Cmd+0 still resets to 100%, custom app menu needed to change that
- [x] sound icon opens mini-player popover (mute, volume, transport, search, gen filter)
- [x] peaceful-only ambient music; battle tracks (379/1376 classified) reserved for battles; manual picks always win
- [x] app icon white ring in dock (full-bleed icns; pre-Tahoe macOS now shows square corners — accepted)
- [ ] background subagents not appearing in the garden (Phase C, in flight)
- [ ] new subagent battle lifecycle: intro fight → loser wanders far zone while working → final fight on completion → faints (Phase C, in flight)
- [ ] garden goes black after overlapping battles (Phase C, in flight)
- [ ] verify updates/upgrades never lose sessions (Phase C, in flight)

Then: user QA pass → `node tools/release.cjs minor` → v1.1.0.

## post-v1.1.0 (one at a time, in rough order)

1. **local diagnostics / metrics** — local-only, nothing phones home: rotated structured log in `~/PokemonHarness/logs/`; capture main-process uncaughtException/unhandledRejection, renderer errors via IPC, render-process-gone details, hook parse failures, nonzero pty exits; invariant counters (battles started vs resolved, hook events received vs routed, subagents spawned vs materialized); settings "diagnostics" row (version, open logs, recent-error count).
2. **arceus dispatch box** — the "describe the task — arceus assigns it" box currently duplicates the terminal (no routing exists yet). Hide it or wire it as a distinct assignment-prompt wrapper until item 3 lands.
3. **"tell chikorita to do X" routing** — speak to arceus naming an agent; arceus relays the instruction to that agent's session. North star of the agent-society phase (claude↔claude cross-session messaging; codex/cursor via file inboxes; per-agent memory; periodic arceus status reports).
4. **arceus persona delivery** — evaluate munder difflin's approach (persona sent as an actual first prompt) vs our `--append-system-prompt`. Trade-offs: system prompt survives compaction and is firmer; first message is transcript-visible and matches MD. Deliberate decision, not a bug.
5. **nebula backdrop grain** — reads too "zoomed in": rendered at coarse internal resolution then upscaled. Fix: higher internal resolution / finer noise, smaller + denser stars. Keep palette, composition, and the calm center zone.

## smaller known items

- quit-dialog caption widths (longest caption may wrap badly in narrow columns) — needs an eyeball
- light-theme lemon accent contrast (~2.3:1) — disclosed, revisit
- cursor-agent binary name check (`which cursor-agent` vs `which agent`)
- Cmd+0 reset-zoom returns to 100% instead of the −0.5 default (needs custom app menu)
- EADDRINUSE hooks-socket note when a second app instance launches (harmless, could message better)

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine
- **tier-2 signed auto-update** if an Apple developer cert ($99/yr) ever makes sense
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
