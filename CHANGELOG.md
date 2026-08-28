# changelog

Completed work, grouped by release. Open work lives in [BACKLOG.md](BACKLOG.md).

## unreleased

- focus mode restyled to the Munder Difflin layout it was modeled on: agent roster moves into a left sidebar ("+ add agent" pinned on top, vertical cards, garden view keeps its bottom strip); header gets the avatar tile + title + status chip with a species/provider subtitle line; the terminal now sits in a framed panel with its own mini header — live dot + label on the left, a [−] [Npx] [+] font-size stepper on the right wired to the same terminal-font setting as the settings slider (re-fits live); the composer becomes a labeled "queue" section with a 4-row textarea and a right-aligned send button. All queue/injection semantics unchanged; the terminal mount stays fixed in the tree so switching views still never blanks it
- topbar view-switcher no longer shifts when switching views: the terminal-panel drawer toggle used to unmount entirely outside garden view (5 buttons → 4), resizing the group and sliding the usage chip / volume / theme / gear cluster; it now always renders, shown muted and inert in other views (tooltip explains it's garden-view-only), so the switcher's geometry is constant across every state

## v1.3.0 — 2026-08-29

- focus mode: the terminal view (Cmd+2) is now a per-agent command center — compact identity header (pokemon face, session name, species, provider, status, cost/context gauges) over the full terminal, with a queue composer at the bottom: type a message and it sends immediately if the agent is idle, otherwise it queues as a removable chip ("sends when idle") and delivers the moment the agent's turn ends — never into a permission prompt, same safety rail as arceus relay (the two share one injection-queue implementation); multiline pastes go through bracketed paste as one turn; the bottom roster strip stays as the agent switcher; arceus keeps his dispatch box as his composer

- macOS Tahoe dock icon finally loses the white ring: Tahoe plates any app shipping only a legacy `.icns` onto its system squircle regardless of full-bleed, so the build now compiles a proper Icon Composer asset (`Assets.car` via actool, `CFBundleIconName` in Info.plist) from the same art, with the `.icns` kept as the pre-Tahoe fallback; verified full-bleed with no plate through AppKit's own icon-resource lookup against the packaged bundle (plus a control test that reproduced the plating bug on purpose)

- arceus task routing ("tell chikorita to do X"): arceus's persona now arrives as a first prompt typed into his terminal on summon (replacing `--append-system-prompt`), including a roster snapshot of every agent (name, species, provider, status); the dispatch box is back under his terminal as the assignment entry, prepending a live roster tag to each message. When — and only when — you ask arceus to relay a task, he emits a one-line `@@relay agent="..." message="..."` directive; the app watches his transcript (not raw pty output, so repaints can't double-fire) and types the instruction into the named session's terminal like user input, for any provider. Targets are matched by session title or unambiguous species alias; busy sessions queue the relay until they're next idle, and nothing is ever injected into a session that might be showing a permission prompt; an unknown name surfaces a toast. Resumed arceus sessions never replay old directives or re-receive the persona

- subagent lifecycle rebuilt to the new design: a spawned subagent's pokemon appears and roams the garden (no intro battle); when the subagent finishes, its pokemon walks to the main agent's pokemon for a single completion battle, loses, and faints. Completion battles queue strictly one-at-a-time with a 4-6s breather between them, across all sessions. The queue is self-healing: each battle runs isolated (one session's throw can't abort others' updates any more), force-concludes on error, and carries a distance watchdog plus a 60s hard cap so nothing can wedge it
- invisible-subagent root cause finally found and fixed (two real bugs): (1) for hook-tracked sessions the parent's Stop event never signaled subagent completion — the only "done" paths were a SubagentStop hook that essentially never fires and a blind 8-minute timer, which is also exactly why a pokemon could faint while its subagent was still running; Stop now deterministically drives completion (a Task blocks the parent's turn until the subagent is truly done). (2) the old battle update loop processed every session under one shared try/catch, so a single throw silently froze ALL battle processing — including the scale-in that makes new bodies visible (they existed at near-zero scale). Bodies now default visible, updates are per-session isolated and logged
- victory celebration after completion battles: checked the sprite source (showdown gen5 ani) for real celebration animations — none exist for any species, so per the no-fabrication rule the existing victory text + sparkle + chime FX stays as the celebration
- "needs you" badge split from plain idle: permission prompts and questions show "needs you"; the CLI's plain waiting-for-input notification now maps to "idle"
- tool dialogue bubble no longer overlaps the status dot / "!" alert above a sprite's head, and hides while its avatar is mid-battle
- brand squash root-caused and fixed: the -0.5 default zoom put Press Start 2P on fractional device pixels app-wide (confirmed by a discriminating screenshot — modal headings were equally soft). Default zoom is back to 0 with the denser feel baked into the CSS type scale instead; every pixel-font size stays integer so glyphs render crisp. Cmd+0 resets to 100%
- topbar overhaul: taller bar (more breathing room for the brand), every icon button normalized to one 30px box with consistent hover/press states, right cluster pinned so it no longer shifts with content; quick settings merged into the single gear at the far right (the sliders icon is gone — gear opens quick settings, "all settings…" opens the full dialog); the active garden chip is one pill with hover-revealed rename/delete inside it (no more floating pencil/trash); press-and-hold no longer paints a selection/drag ghost across the topbar; "workspace" dialog copy now says "garden"

- in-app provider usage limits (codexbar-style, opt-in and OFF by default): settings → usage toggle; while on, a topbar chip shows the single tightest limit and opens a trainer-card popover — per-provider pixel HP-style bars for the 5h session / weekly / model-scoped windows with reset countdowns, plus a tracked-cost strip. claude reads the CLI's own keychain credential read-only to ask the same usage endpoint the CLI uses (never stored/refreshed/proxied; toggle off tears the poller down the same tick with zero credential access); codex prefers the CLI's local rollout logs (no credential or network needed) with a network fallback; distinct actionable error states (401 "unauthorized — open a claude session to re-authenticate", locally-expired, rate-limited shows stale data, plain errors muted) modeled on codexbar; cursor omitted (no public individual usage api). endpoint/credential research documented in docs/usage-limits-research.md
- "hide claude statusline" toggle (settings → terminal, off by default): suppresses the user's global claude code statusline inside pokéharness terminals only, via a `statusLine` no-op override in the per-session `--settings` file the app already generates — other terminals keep it; also hides claude's footer hints (disclosed in the hint copy); applies to newly started sessions
- garden no longer flickers while dragging the garden/terminal splitter: root cause was pixi's `renderer.resize()` clearing the canvas bitmap up to 60×/s mid-drag; the canvas now stretches via CSS during the drag with one real resize on release, and the terminal-side refit/pty-resize thrash is gated the same way (also eliminates the hundreds of "ResizeObserver loop" errors the drag wrote to the diagnostics log)
- roster card shows the pokemon's species name; the "change pokemon" action is now a visible labeled pill (~10x the old hit area) instead of a tiny corner icon
- pokemon picker enlarged: 680px modal, 72px sprites, bigger cards/text, viewport-relative grid height; fixed the invisible not-yet-loaded placeholder
- change-pokemon now swaps to EXACTLY the species picked (a max-evolved session can go back to a base form) and rebases the evolution clock to that stage so the cycle restarts from there; picking the current species restarts its cycle too; new "keep at this stage — don't evolve" checkbox (per-session, reversible) freezes evolution at the chosen form while everything else (battles, bubbles, naps) continues

## v1.2.0 — 2026-08-29

- garden tool bubble redesigned as a miniature Game Boy-style dialogue box (hard 2px pixel border, opaque parchment fill, blocky pixel step-tail, stepped pop-in instead of a smooth fade) and repositioned to sit a small consistent gap above each sprite's own head — was floating a fixed distance above every species regardless of height, and tall sprites like Meganium could clip it; bubble content also reworked from raw truncated paths/commands (`$ sed …nderer/src/index.css`) into short human phrases (`editing index.css`, `running sed`, `searching TODO`, `summoning help`) via a new bubble-specific label formatter, hard-capped to 24 chars — the roster card keeps its existing compact path/command form
- draggable divider between the garden and terminal drawer in 'garden' view mode (pointer-events drag, rAF-throttled; garden min 380px / terminal min 420px via CSS `clamp()` so a window resize re-applies both for free; double-click resets to the default split; ratio persists across launches, same `localStorage` pattern as `viewMode`)
- roster card gains a "change pokemon" action: swaps an existing session's species via the same full-dex picker as new-session creation, keeping accumulated working time (the new species spawns at whatever stage that time already earned) and the shiny flag; no evolution ceremony plays for the swap itself
- pokemon picker fixes: browsing (not just search) now covers the full ~1025-species dex, thumbnails lazily decoded as options scroll into view; fixed-size cards so sprite/name height no longer misaligns the grid
- settings is now a centered dialog (was a right-edge slide-in panel): left rail of section links (appearance/automation/harness home/arceus/sound/terminal/config/closing time/about/diagnostics) with the active section's content on the right, matching the app's `.modal` conventions (backdrop click + Escape close); every existing setting and control unchanged
- new topbar "quick settings" popover for the handful of things worth reaching mid-flow — theme, mute-all/music on-off/volume, claude auto mode, keep-awake — plus an "all settings…" row into the full dialog
- hardened the hook-event → battle-signal path against a silent throw anywhere in it (v1.1.0's disappearing subagent-battle spawns): the hook callback, the PreToolUse battle-spawn emit, and each battle-bus listener are now individually try/caught and logged (`hook-router`/`battle-spawn`/`battle-bus`), with a new `battleSignalErrors` diagnostics counter
- fixed dead whitespace left of the topbar brand in macOS fullscreen: the traffic-light-safe inset now drops to normal content padding once main pushes fullscreen state to the renderer, instead of staying reserved after the traffic lights auto-hide
- local-only diagnostics: rotated JSONL log at `<harness home>/logs/harness.log` (2MB cap, 3 files kept); captures main uncaughtException/unhandledRejection, render-process-gone, malformed hook payloads, the harmless second-instance EADDRINUSE on the hooks socket, and nonzero pty exits, plus renderer errors (window.onerror/unhandledrejection) forwarded over IPC; invariant counters (battles started/resolved, hook events received/routed/dropped, subagents spawned/materialized/cleaned up) snapshotted every 60s and on quit, with a warn logged when a pair stays diverged too long; Settings gains a "diagnostics" row (app + electron version, logs folder with an open-logs button, errors-this-session count). Nothing here ever leaves the machine.
- custom application menu (app/Edit/View/Window, standard roles kept — copy/paste in text fields unaffected) so Cmd+0 resets zoom to the app's −0.5 default instead of Chromium's 100%; Cmd+plus/minus still step ±0.5 relative
- cursor provider detection now tries `cursor-agent` then falls back to `agent` (Cursor has shipped both binary names), using whichever resolves on PATH
- hid the Arceus "describe the task" dispatch box (it just duplicated the terminal below) — temporary, pending real task-routing ("tell chikorita to do X")
- topbar restructure: arceus's chip (now with a status dot) is his one home — his roster card is gone from the bottom strip/sessions overview; gardens (workspaces) moved out of a dropdown into chips inline in the topbar, with a "+ new garden" button and rename/delete on the active chip; the view-mode toggles, terminal-panel show/hide, and "all sessions" are now one icon group with lowercase tooltips, settings moved to the very end of the topbar; "+ new session" is "+ new agent" everywhere
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
