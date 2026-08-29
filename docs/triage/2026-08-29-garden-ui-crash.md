# garden UI crash — 2026-08-29 ~04:13 GST (00:13Z) — TRIAGE ONLY, not yet dispatched

User report: "the garden UI just crashed rn (around 4:13-4:13am GST)". App: installed v1.3.0. Do not fix yet — user asked to hold. This file is the context package for the eventual fix agent.

## Evidence (harness.log ~/PokemonHarness/logs/harness.log, all UTC)

- Main process ALIVE throughout: counter snapshots continuous every 60s across 00:05→00:45, no gap at 00:13.
- Hook pipeline healthy: hookEventsReceived kept climbing through the window (903 @00:12 → 911 @00:13 → 922 @00:14), hookEventsDropped 0.
- NO error-level log entry anywhere near 00:13. Last error in the whole file remains the known 23:37:20Z tickBattleFx throw (fixed on master, unreleased at crash time).
- No macOS crash report: newest Pokeharness .ips in ~/Library/Logs/DiagnosticReports is Aug 28 20:42 (previous day, unrelated); nothing for Aug 29.
- Renderer JS error logging PROVABLY works: renderer "ResizeObserver loop" errors reach harness.log via the window error path. Therefore an uncaught renderer JS exception at 00:13 would have been logged. None was.
- 00:39:32Z snapshot: subagentsCleanedUp jumped 1→7 (battlers reaped en masse) with hookEventsReceived momentarily flat (1126) — consistent with a garden scene re-init around 00:38-39Z (04:38-39 GST): user switching views / reload / canvas recovery. Normal flow resumed after (recv 1126→1134 by 00:40).
- Context at the time (v1.3.0 known state): the 23:37Z FX-loop bug means BattleManager.update() had been throwing EVERY FRAME for ~46 minutes by 00:13 (outer GardenScene catch swallows after logging once). 7 battlers existed; 6 invisible (poof-in starved).

## Leading hypotheses (in order)

1. WebGL/GPU context loss on the Pixi canvas — invisible to window.onerror, nothing subscribes to `webglcontextlost` or Electron's `child-process-gone` (gpu) / `render-process-gone`, so it would be exactly this silent. The per-frame throw storm for 46 min (46*60*~60fps exception unwinds through Pixi's ticker) is a plausible aggravator (GC/driver pressure), as is the app's known "Using Significant Energy" GPU load (phase F).
2. Renderer process crash-and-auto-reload — would explain "crashed" + later recovery, BUT main logs nothing for render-process-gone (no handler = no log, Electron shows blank until reload; user did not report an app relaunch) — cannot confirm or exclude from logs.
3. NOT a main-process crash, NOT an uncaught renderer JS exception (both excluded by evidence above).

## Questions for the user (ask when dispatching)

- What exactly did "crashed" look like: garden went black/frozen while the rest of the UI (topbar/terminals) still worked? whole window blank? error dialog? app quit?
- Did it recover on its own, or after switching views / Cmd+R / relaunch (~04:38 GST)?

## Instrumentation the fix agent should add regardless of root cause

- `webglcontextlost`/`webglcontextrestored` listeners on the Pixi canvas → log + attempt Pixi context restore / scene rebuild.
- main: `app.on('child-process-gone')` + `webContents.on('render-process-gone')` → log reason codes (this is the missing witness for hypothesis 2).
- A renderer heartbeat in the counters snapshot (last renderer frame ts) so main-side logs can show when the render loop stops.

Note: the v1.4.0 release shipping today (FX purge + per-phase isolation) removes the throw-storm aggravator; the crash may not reproduce after the update. Keep this open until a clean week on 1.4.0.
