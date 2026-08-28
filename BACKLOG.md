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
- [x] background subagents not appearing in the garden (root cause: the CLI reports every subagent dispatch as an instant async launch and emits no reliable completion hook; lifecycle no longer depends on those signals)
- [x] new subagent battle lifecycle: intro fight → loser wanders its own far corner while working → final fight on completion → faints (8-min safety fallback since the CLI emits no trustworthy completion event)
- [x] garden black-screen hardening: battle update loop can no longer kill the render frame; crash vector under concurrent battles removed (not a confirmed repro of the exact report — watch for recurrence)
- [x] verified: updates never lose sessions (atomic persistence flushed before quit, `--resume` respawn, userData path pinned by app name independent of bundle churn; update check never touches state)

Then: user QA pass → `node tools/release.cjs minor` → v1.1.0.

## post-v1.1.0 (one at a time, in rough order)

1. **arceus dispatch box** — the "describe the task — arceus assigns it" box currently duplicates the terminal (no routing exists yet). Hide it or wire it as a distinct assignment-prompt wrapper until item 2 lands.
2. **"tell chikorita to do X" routing** — speak to arceus naming an agent; arceus relays the instruction to that agent's session. North star of the agent-society phase (claude↔claude cross-session messaging; codex/cursor via file inboxes; per-agent memory; periodic arceus status reports).
3. **arceus persona delivery** — evaluate munder difflin's approach (persona sent as an actual first prompt) vs our `--append-system-prompt`. Trade-offs: system prompt survives compaction and is firmer; first message is transcript-visible and matches MD. Deliberate decision, not a bug.
4. **nebula backdrop grain** — reads too "zoomed in": rendered at coarse internal resolution then upscaled. Fix: higher internal resolution / finer noise, smaller + denser stars. Keep palette, composition, and the calm center zone.

## smaller known items

- quit-dialog caption widths (longest caption may wrap badly in narrow columns) — needs an eyeball
- light-theme lemon accent contrast (~2.3:1) — disclosed, revisit
- cursor-agent binary name check (`which cursor-agent` vs `which agent`)
- Cmd+0 reset-zoom returns to 100% instead of the −0.5 default (needs custom app menu)

## bigger later

- **agent society phase** (carries backlog item 3)
- **demo mode + auto-run showreel + portfolio landing page** with live web embed of the garden engine
- **tier-2 signed auto-update** if an Apple developer cert ($99/yr) ever makes sense
- load-test 15+ concurrent chatty sessions (FPS/CPU/IPC), batch output only if measurements warrant
- decide whether the GitHub repo renames to match the app (redirects make it safe)
