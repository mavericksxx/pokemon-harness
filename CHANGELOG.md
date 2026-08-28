# changelog

Completed work, grouped by release. Open work lives in [BACKLOG.md](BACKLOG.md).

## unreleased

- local-only diagnostics: rotated JSONL log at `<harness home>/logs/harness.log` (2MB cap, 3 files kept); captures main uncaughtException/unhandledRejection, render-process-gone, malformed hook payloads, the harmless second-instance EADDRINUSE on the hooks socket, and nonzero pty exits, plus renderer errors (window.onerror/unhandledrejection) forwarded over IPC; invariant counters (battles started/resolved, hook events received/routed/dropped, subagents spawned/materialized/cleaned up) snapshotted every 60s and on quit, with a warn logged when a pair stays diverged too long; Settings gains a "diagnostics" row (app + electron version, logs folder with an open-logs button, errors-this-session count). Nothing here ever leaves the machine.

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
