# changelog

Completed work, grouped by release. Open work lives in [BACKLOG.md](BACKLOG.md).

## unreleased

- hardened the hook-event → battle-signal path against a silent throw anywhere in it (v1.1.0's disappearing subagent-battle spawns): the hook callback, the PreToolUse battle-spawn emit, and each battle-bus listener are now individually try/caught and logged (`hook-router`/`battle-spawn`/`battle-bus`), with a new `battleSignalErrors` diagnostics counter
- fixed dead whitespace left of the topbar brand in macOS fullscreen: the traffic-light-safe inset now drops to normal content padding once main pushes fullscreen state to the renderer, instead of staying reserved after the traffic lights auto-hide
- local-only diagnostics: rotated JSONL log at `<harness home>/logs/harness.log` (2MB cap, 3 files kept); captures main uncaughtException/unhandledRejection, render-process-gone, malformed hook payloads, the harmless second-instance EADDRINUSE on the hooks socket, and nonzero pty exits, plus renderer errors (window.onerror/unhandledrejection) forwarded over IPC; invariant counters (battles started/resolved, hook events received/routed/dropped, subagents spawned/materialized/cleaned up) snapshotted every 60s and on quit, with a warn logged when a pair stays diverged too long; Settings gains a "diagnostics" row (app + electron version, logs folder with an open-logs button, errors-this-session count). Nothing here ever leaves the machine.
- custom application menu (app/Edit/View/Window, standard roles kept — copy/paste in text fields unaffected) so Cmd+0 resets zoom to the app's −0.5 default instead of Chromium's 100%; Cmd+plus/minus still step ±0.5 relative
- cursor provider detection now tries `cursor-agent` then falls back to `agent` (Cursor has shipped both binary names), using whichever resolves on PATH
- hid the Arceus "describe the task" dispatch box (it just duplicated the terminal below) — temporary, pending real task-routing ("tell chikorita to do X")
- cosmos nebula backdrop reworked at 2.5x the internal resolution (128x80 → 320x200, dither cell and feature-star coordinates/radii scaled to match, cloud noise lattice 10 → 16, starfield 90 → 350 stars) so it no longer reads as "too zoomed in"
- arceus warp reworked to actually read as pixel art: the streak burst is now 6 frame-flipped 32x32 hard-edged rasters per direction (was one texture continuously `transform: scale`d, which produced uneven, non-integer pixel blocks at arbitrary scale factors) in each direction's small fixed 3-color palette (no per-pixel blending); the midpoint flash is now a 17-level Bayer-ordered blocky dissolve in the direction's own accent color (was a plain white opacity fade), still guaranteed fully opaque through the scene swap (plus a hitch-proof forced-cover frame on any tick that jumps clean over the plateau); both frame sets are prewarmed on mount so no transition pays first-generation cost mid-animation
- quit-dialog widened (460px → 600px, ~136px → ~183px per action column) with balanced caption wrapping so all three action captions read cleanly at 2 lines
- light-theme accent darkened to a deeper amber (`#DCAB3C` ~2.08:1 → `#7D5312` ≥4.5:1, worst case ~4.77:1) everywhere it's used as text or a thin stroke/outline (chip labels, active states, focus ring, toast/card accents); fills (buttons, the arceus chip's active state, the evo-bar/checkbox swatches) keep the brighter literal accent with dark text on top

## v1.1.0 — 2026-08-28

- long-text overflow fixes: compact tool labels everywhere (bash → `cmd …tail`, paths → `…/parent/file.ext`), roster-card/workspace-button/session-chip truncation, hardened topbar brand inset
- merged the duplicate terminal view modes into one; three view modes remain
- settings panel redesigned to the design system: pixel checkboxes/slider, segmented lowercase theme picker, terse labels with muted hints
- light mode now themes open terminals live (full light ANSI palette), including system-mode OS flips; theme toggle added to the topbar
- default zoom set one notch out (−0.5)
- sound icon opens a mini-player popover (mute, volume, transport, search, gen filter); mini-player extracted to a shared component
- ambient garden music draws only from peaceful tracks (379 battle / 997 peaceful classified from real titles); battle music reserved for battles; manual picks always win
- dock icon rebuilt full-bleed — no more white ring on macOS Tahoe
- subagent lifecycle rebuilt: every subagent (including backgrounded ones, which the CLI reports without reliable hooks) gets a body in the garden — intro skirmish, then wandering its own far corner while it works, then a final skirmish and faint on completion; concurrent subagents choreograph safely
- garden render loop hardened against battle-system exceptions (black-screen vector) and a concurrent-battle crash vector removed
- verified update-survival of sessions: atomic persistence, resume-on-relaunch, stable storage paths across versions
- arceus transition reworked: vertical ascent replaced with a ~720ms bidirectional pixel-streak warp (violet in, green/gold out), scene swap hidden under the flash
- summon-once arceus: setup dialog only ever on first run; auto-returns on every later launch

## v1.0.0 — 2026-08-28

First release. Everything below was built from scratch this cycle.

**Core harness**
- CLI sessions (Claude Code, Codex, plain shell) run in in-app xterm.js terminals; each session is a Pokémon wandering a pixel-art garden
- Claude Code hooks shim (per-session settings → unix socket → app) drives accurate activity states; codex tracked via output parsing
- evolution from accumulated working time; full Gen 1–5 animated dex picker with lazy sprite fetch; shiny odds; subagent battles with walk-up choreography and floating move text
- compaction naps, loop-detection badge, blocked/"needs you" states, select-to-cry interactions

**Resilience**
- continuous session persistence, crash re-adoption, renderer auto-reload, `claude --resume` restore on relaunch; evolution progress survives crashes

**Operations**
- cost & context gauges from transcript telemetry; keep-awake; quit dialog with closing-time sunset ritual; native notifications; auto-mode toggles (global + per-session)

**Workspaces & arceus**
- multiple gardens (one per repo/project) with instant switching, Cmd+Shift+1–9; harness home dir
- arceus god agent: real claude session with persona, cosmos view with procedural pixel nebula and cycling type plates, global across workspaces

**Sound**
- 1377-track music catalog across all 9 gens with disk LRU cache and streaming prefetch; mini-player; battle-music takeover with crossfade; per-bus volume/mute; cries and move SFX

**Look & feel**
- munder-difflin-inspired design system (charcoal + gold, hard shadows, Press Start 2P chrome), light + dark themes following the system, lowercase voice, zero emojis (hand-drawn pixel icon set), pokéball iris-wipe boot
- four view modes → three; bottom roster strip; diorama garden framing

**Ship**
- packaged macOS .app (ad-hoc signed; ASCII bundle name fix for the AMFI é crash), dock icon, README with credits and fan-use notice
- GitHub Releases update channel: release script + in-app update check (launch + daily) with toast
