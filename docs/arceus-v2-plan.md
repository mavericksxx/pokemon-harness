# Arceus v2 — full redesign plan

Status: **fully decided, advisor-reviewed, spike-verified. Ready for implementation.**
Locked: 2026-09-12.

**This file is a temporary planning artifact, not permanent project documentation.** Once §7's
implementation scope has been built, reviewed, and merged, delete this file — its content should
live on as actual code + the git history + `CHANGELOG.md`/`BACKLOG.md`, not as a standing doc.

This document is the complete record of the redesign conversation — written so implementation
can proceed from this file alone, without needing the original conversation. Nothing here is
speculative; everything marked "confirmed" was checked against real code or tested empirically.

---

## 1. Why this redesign

The user wants to interact with the app almost entirely through Arceus: describe a task once,
and have Arceus figure out which project it belongs to and which agent should handle it, rather
than manually opening a new session and picking a workspace/agent every time.

## 2. Current shipped baseline (as of 2026-09-11, verified against code)

- Arceus is a **fixed, persistent real `claude` CLI session** (`ARCEUS_SESSION_ID`,
  `src/shared/arceus.ts`) — not a garden walker. Gold roster card, cosmic "Hall of Origin" warp
  view (`ArceusWarp.tsx`, `GardenScene.tsx`).
- Persona is delivered as his **first prompt** (not `--append-system-prompt`) —
  `buildArceusFirstPrompt` in `src/shared/arceus.ts`.
- Routing today: `src/main/arceusRelay.ts`'s `ArceusRelayWatcher` tails his pty output for a
  `@@relay agent="..." message="..."` text line (regex match) and injects it into the target
  session's pty (same mechanism as manual typing). Relay-only autonomy — his system prompt
  forbids emitting `@@relay` unless the user just asked him to. No proactive behavior exists.
- **Provider is already selectable** via `SummonArceusDialog.tsx` — a real dropdown (claude/codex)
  + a free-text model field — but **only shown on a genuine first run**. After that, every later
  summon silently reuses the saved config (`saveArceusSummonConfig`/`loadArceusSummonConfig` in
  `src/main/arceusSummonConfig.ts`). To change it today: Settings → `ResetArceusDialog.tsx` →
  re-summon. There is also a **pre-existing bug**: the relaunch/`--resume` path
  (`sessionRespawn.ts`) does not read the saved provider/model back at all — so changing it and
  relaunching the app silently reverts. Needs fixing regardless of anything else in this plan.
- `SummonArceusDialog.tsx` already has an accurate inline warning: relaying to other agents
  (`@@relay`) only works when Arceus is running on Claude — it depends on reading Claude's own
  hooks/transcript format.
- `poke-delegate` (`src/main/hookBridge.ts`'s `DELEGATE_CLI_SCRIPT`, filename
  `poke-delegate.cjs`) already exists: a tiny CLI Arceus (or any Claude session) runs via its own
  Bash tool that does one UDS socket round-trip (`net.createConnection`) to the app's main
  process and prints a result. This already works for Claude → spawn-a-Codex-delegate.
- Workspaces are a real first-class concept (`src/shared/workspaceTypes.ts`:
  `{id, name, primaryFolder, createdAt, accent}`) — one garden per project, switchable.
- `roster.json` (`src/main/arceusRosterFile.ts`) is a full-overwrite snapshot
  (`{title, pokemon, provider, status, workspace}` per session, `workspace` = opaque id) that
  Arceus is told to read with his own tools. Excludes his own entry.
- Codex delegate spawns use `--sandbox workspace-write` (`src/main/index.ts:381-382`,
  `src/shared/agentProvider.ts:66`), no special network exception.

## 3. Decided design (the actual plan)

### 3.1 Dispatch flow
User talks only to Arceus. He identifies which **project (Workspace)** a request belongs to:
- **States his inferred guess and proceeds** if confident (no interruption).
- **Calls `poke-ask`** only if genuinely ambiguous between multiple plausible active projects.

Once the project is identified:
- If an **idle agent already exists** there → **always** calls `poke-ask` (never decides
  silently) offering reuse-that-agent (showing what it was last doing, via a `lastDispatch`
  field) vs. spawn-fresh. This is deliberately unconditional — protects against a task silently
  overwriting/mixing into unrelated context an idle agent's owner might want to resume later.
- If **no idle agent exists** in that project → calls `poke-spawn` directly, states that's what
  he's doing.

**v1 scope is single-target only** — no fan-out/decomposition of one request across multiple
agents or projects. Explicitly deferred to a later phase.

### 3.2 The three tools — and the critical correction from spiking

Original plan: `poke-ask`, `poke-spawn`, and a migrated `poke-relay` (replacing the `@@relay`
text-directive) would all be real **blocking** tool calls over the existing `poke-delegate`
UDS-socket pattern — Arceus's Bash tool call would pause until the user answered, then the same
turn would continue.

**This was tested empirically and does NOT work.** See §4 (spike 1). The corrected design:

- Each tool **fires and returns immediately** (e.g. "waiting on the user's answer").
- Arceus's turn ends normally (he is genuinely idle while waiting — no special-casing needed).
- When the user answers the picker, the app **injects the answer as a new message** into
  Arceus's pty — the exact same mechanism `ArceusDispatchBox.tsx` already uses to type into his
  session (`window.api.writePty`). This starts a fresh turn where he acts on the answer.
- Same user-facing experience as originally envisioned; different, and now verified-viable,
  plumbing underneath.

Migrating `@@relay` → `poke-relay` means **deleting the whole `ArceusRelayWatcher`
transcript-tailing mechanism** (`src/main/arceusRelay.ts`), not just removing its
`queue.clear()` bug (see §5). `poke-relay` must also **return immediately** rather than blocking
until the target agent goes idle (today's `InjectionQueue` can hold a relay for minutes) — same
constraint as above.

### 3.3 Provider scope for Arceus's own body — spike-confirmed

**Claude is the fully-supported provider for Arceus** running this whole feature.

**Codex-Arceus cannot use `poke-ask`/`poke-spawn`/`poke-relay`** under the sandbox mode the app
uses today (`-s workspace-write`) — confirmed empirically (§4, spike 2b) using the actual
production connection code (`net.createConnection`, not a stand-in): the connection attempt
fails with `EPERM`, an OS-level sandbox denial.

**Decision: do not silently try to "fix" this.** Codex-Arceus stays exactly as it is today —
chat/relay via the dispatch box, no autonomous tool use — unless a **separate, deliberate**
future decision is made to run him under `-s danger-full-access` (full network access; a real
security tradeoff, not something to bundle into this work).

### 3.4 Plumbing gaps found by the final assembled-design review

- **`roster.json` needs a workspaces registry block** — today it only carries an opaque
  `workspace` id per session; Arceus needs `{id, name, primaryFolder}` to actually identify
  "which project" a request belongs to, and to give `poke-spawn` a cwd. The checkpoint handler
  (`src/main/ipc/sessions.ts`) doesn't currently receive the workspace registry — needs wiring.
- **Add a `lastDispatch` (or `lastArceusDispatch`) field** to each roster entry — `{at, message}`
  — this is the highest-value single continuity signal for "reuse this idle agent" decisions and
  for "actually, also do X" follow-ups. (A bespoke JSONL exchange log was considered and **cut**
  — see §6 — because this field covers nearly all its value at a fraction of the surface.)
- **Permission-allow rules needed** for the three `poke-*` commands — every call is a Bash tool
  use; with auto-mode off (the dialog's default), Claude will ask permission in a terminal the
  user isn't watching, and Arceus goes 'blocked'. Fix: install `poke-ask`/`poke-spawn`/
  `poke-relay` as bare PATH-resolvable wrappers in a **separate directory from `cli-shims/`**
  (which shadows `claude`/`codex` and must not be on Arceus's PATH), and add
  `permissions.allow: ["Bash(poke-ask:*)", ...]` entries to the per-session settings file
  `prepareSession` already writes (`hookBridge.ts`).
- **Security guard**: today, tool identity is just two trusted env vars (`POKE_HOOK_SOCK`,
  `POKEHARNESS_AGENT_ID`) — any harness session could in principle call `poke-relay` and type
  into another agent's terminal. Add a guard: reject unless
  `parentAgentId === ARCEUS_SESSION_ID`.
- **Env stamping is currently gated to `provider === 'claude'`** (`pty.ts`) — this would need to
  change for a hypothetical future Codex-Arceus to reach the tools at all (moot for now given
  §3.3, but note it so nobody assumes it's already provider-agnostic).
- **Async round-trip**: `poke-spawn`/`poke-ask` need a main→renderer→main round trip (species
  pick, store entry, terminal creation, and workspace assignment all live in the renderer's
  `sessions.ts`/`startSession`), unlike `poke-delegate` which stays main-side. The UDS handler
  needs to become async with its own timeout, not the current synchronous `bind()`/`handle()`.

### 3.5 Persona delivery

One **composed** `--append-system-prompt-file` per Arceus spawn (persona text +
`agents/arceus/roster.json` pointer). **HARNESS.md is excluded** — he doesn't write code himself,
only routes/spawns/relays.

**Critical implementation detail**: there are **three real Arceus spawn paths** —
`summonArceus` (`src/renderer/src/arceus.ts`), `tryResumeArceus`, and the boot-time relaunch path
(`sessionRespawn.ts` → generic `respawnSession`) — and today only one carries persona logic. The
composed file must be built at the **shared `PtyManager.spawn` choke point**, keyed on
`opts.id === ARCEUS_SESSION_ID`, or two of the three paths will silently spawn him with no
persona at all.

Also: the app already appends **one** `--append-system-prompt-file` (HARNESS.md) to every
non-delegate Claude spawn including Arceus's today (`pty.ts`) — a second one for his persona
would silently collide (last-value-wins). Must compose ONE file, not append two. The Codex side
has the identical last-wins collision on `-c developer_instructions=` (irrelevant for now per
§3.3, but relevant if Codex-Arceus is ever revisited).

The persona-as-first-prompt mechanism (`armFirstPromptDelivery`, `buildArceusFirstPrompt`, and
— for Codex — its 3-second readiness timer) gets **deleted** by this change.

### 3.6 Ambient status (the "Hall of Origin" cosmic view)

- Opening/selecting Arceus shows a **synthesized one-line summary by default** — see §6 for why
  this is now a **free, rule-based** one-liner, not a model call
  (e.g. *"4 agents: 2 working, 1 needs you, 1 idle · last: 'fix auth' → chikorita 6m ago"*).
- The full **per-agent status board** (rows: species/name, project, status pill, idle time) is
  **hidden by default**, behind a "show details" toggle.
- Underlying rule-based status pills are always free (no model call — straight from session
  state), shown in the board once expanded.
- One consolidated panel, never multiple stacking popups/toasts for ambient info.

### 3.7 Visual redesign (mocked up and approved)

Built and iterated as a Claude Artifact
(`https://claude.ai/code/artifact/7e11e808-258a-42a2-be31-75b750365ce0` — private to the user).
Final approved shape:

- **Full-bleed procedural pixel-art galaxy backdrop** filling the entire cosmic view: deep-indigo
  cosmos corners, an off-center warm horizontal galaxy band running through the middle, violet
  haze, dust-lane clumps, a dithered multicolor starfield, and a calm/clear zone directly behind
  where Arceus's sprite floats (deterministic seeded PRNG generation, same spirit as the real
  `nebula.ts` — not `Math.random()`).
- His **real sprite floats left-of-center** over the backdrop with a soft radial CSS mask
  blending its edges into the generated backdrop (his real screenshot/sprite has its own baked-in
  dark background that needs blending, not a hard rectangle), plus the same gentle bob the real
  app already gives him.
- A **right-side HUD column** overlays the cosmos directly (translucent panels, not a separate
  solid side panel): the one-line summary card (with a "show details" toggle and a "refresh"
  action) at top, then the exchange/dispatch conversation area growing to fill remaining height,
  dispatch input pinned at the very bottom. This column got **wider and taller** than the first
  draft specifically because a cramped bottom-docked strip felt empty/cramped for real
  conversation history — it's a real layout call, not just a mockup patch.
- Everything themed with the app's **real design tokens** — Press Start 2P for chrome
  headers (only at 8/12/16px, its pixel grid breaks otherwise), Inter for body/UI, JetBrains Mono
  for data/status/technical strings, `radius: 0` everywhere (sharp corners = "reads as game UI"),
  hard 4px offset shadows (no blur), the real gold-bezel viewport frame technique
  (`--arceus-gold-deep`/`--gold`/`--arceus-gold-bright` inset box-shadow stack +
  hard-edged 4×4 corner pixel accents), and the real pixel pokéball brand icon (exact SVG from
  `icons.tsx`).
- The blocking-style `poke-ask` picker (now actually a modal shown while waiting for the async
  answer, per §3.2's corrected mechanism) is a centered overlay themed with the same
  `--arceus-gold`/`--arceus-ground` tokens — radio-style option cards, one showing "continue with
  <agent> — last task: '...' · idle Nm", the other "spawn a new agent".
- **Follow-up noted, not yet scoped**: port this improved procedural galaxy design back into the
  real app's actual `nebula.ts` (today's real one is plainer/more centrally cropped than this
  mockup's backdrop) — the user explicitly wants the real app enhanced to match the mockup, not
  just the mockup to look nice in isolation.

### 3.8 Provider/model switching UI

The mockup adds an inline "change model" affordance directly in the summary card (a small
"claude · sonnet ✎" link that reveals a provider dropdown + model text field + apply button) —
**so switching doesn't require leaving the Hall of Origin view for Settings**. This is UI
surfacing of a capability that **already exists underneath** (see §2) — deferred to build
alongside/after the core dispatch work, not blocking it. The one fix that's needed regardless of
whether this inline UI ships: the relaunch-path bug where the saved provider/model isn't actually
read back on app restart.

What "apply" needs to do operationally (from the advisor review):
- **Provider change** → unavoidable kill + fresh summon (conversation is lost; acceptable, see
  §3.5/§6 — nothing durable lives in the transcript by design). Must also cancel any pending
  timers tied to the old process.
- **Model change, Claude→Claude** → cheapest option: type `/model <name>\r` into his live pty —
  no respawn, no conversation loss — and save the config. (Respawning via
  `--resume <id> --model <name>` is the alternative but `tryResumeArceus` doesn't currently accept
  extra args.)
- **Model change involving Codex** → Codex's `/model` is an interactive picker, not a flag, so a
  Codex-side model change requires a respawn.

## 4. Spike findings (empirical, not opinions)

Two go/no-go questions were identified before committing to implementation, and both were tested
directly against the real CLIs (not simulated) — the harness's own safety classifier blocks
Claude from spawning nested `claude`/`codex` processes itself ("Create Unsafe Agents"), so the
user ran these manually via the `!` prefix.

### Spike 1 — does a blocking Bash-tool call survive a multi-minute wait?

Test: `claude -p` instructed to run `sleep 300 && echo POKE_ASK_DONE_MARKER` via its Bash tool
with an explicit 400-second tool timeout and `BASH_MAX_TIMEOUT_MS`/`BASH_DEFAULT_TIMEOUT_MS`
raised to 600000ms.

**Result: REFUSED outright, in ~7-8 seconds total.** The raw tool result (captured via
`--verbose --output-format stream-json`):

```
<tool_use_error>Blocked: sleep 300 followed by: echo POKE_ASK_DONE_MARKER. To wait for a
condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a
command you started, use run_in_background: true. Do not chain shorter sleeps to work around
this block.</tool_use_error>
```

This is a **hard product-level guardrail**, not a soft timeout or auto-backgrounding risk — Claude
Code will not let its own Bash tool block synchronously waiting on an external event, regardless
of what timeout value is passed. **Conclusion: the original "single blocking tool call" design
for `poke-ask` is not viable as conceived.** See §3.2 for the corrected (fire-immediately +
async-inject) design this led to.

### Spike 2 / 2b — can a Codex session under `-s workspace-write` reach a UDS socket?

First attempt (spike 2) used `nc -U <socket>` from inside `codex exec -s workspace-write` — it
failed (exit 1, ~0ms, initially with a `File name too long` red herring from an over-long test
socket path; after fixing the path, still exit 1 with zero output). **This result was judged
inconclusive** — `nc` is a different binary than the real production code path
(`poke-delegate.cjs` uses Node's `net.createConnection` via an Electron-re-exec'd-as-node
process), and macOS sandboxing can in principle differ by calling binary.

Follow-up (spike 2b) reproduced the **actual** connection logic faithfully: a minimal Node script
(`poke_probe.cjs`) using the literal same `net.createConnection(sock, ...)` pattern as the real
`DELEGATE_CLI_SCRIPT`, run via plain `node` from inside `codex exec -s workspace-write`.

**Result: `PROBE_RESULT: ERROR: EPERM connect EPERM /tmp/pokespike2b.sock`** — a clean, explicit
OS-level permission denial, using the real connection code. **Conclusion: confirmed, not
inconclusive — Codex's default `workspace-write` sandbox blocks UDS socket connections outright.**

Important note on why this doesn't contradict "Luna delegation already works" (which the user has
used successfully): today, `poke-delegate.cjs` is always invoked by **Claude** (Arceus is
Claude-only today), and Claude's Bash tool has no OS-level sandbox at all (only human-approval
gating) — so the existing working delegation flow has never actually exercised
"seatbelt-sandboxed process reaching a UDS socket." The spike tested a genuinely new case, not a
regression of a working one. See §3.3 for the resulting decision.

## 5. Known pre-existing bugs to fix along the way (not new work, just don't forget)

- `ArceusRelayWatcher.onHookPayload` calls `this.queue.clear()` on every new transcript path,
  discarding any in-flight relay — moot once `@@relay`/`ArceusRelayWatcher` is deleted per §3.2,
  but note it in case any interim state keeps the old mechanism alive during a staged rollout.
- The relaunch/`--resume` path doesn't read the saved Arceus provider/model config at all (§2,
  §3.8) — fix regardless of whether the inline switch UI ships.

## 6. Deliberately cut / deferred for v1 (avoid over-building)

- **Cut: "cheap Haiku summary" for the ambient one-liner.** This architecture has no direct API
  access — "a cheap model call" would actually mean spawning a real `claude -p --model haiku`
  process on every open (2-4s cold start, a real turn/cost on the user's plan, hook shim firing
  unless suppressed, and it doesn't exist at all for a Codex-only user). Replaced with a free,
  deterministic rule-based one-liner (§3.6). If a model-generated summary is ever wanted later,
  cache it by roster hash with an explicit refresh — don't regenerate on every open.
- **Cut: bespoke JSONL exchange log.** With persona in argv (stateless-by-design) and `roster.json`
  extended with `lastDispatch` (§3.4), a log of every exchange isn't needed for v1's continuity
  requirements. His real live transcript already exists if a "what have we been discussing" view
  is ever wanted.
- **Deferred: `/clear`-based context-reset lifecycle.** Not needed at launch — Arceus's context
  grows slowly (mostly tool calls + file reads via `poke-*`, not long freeform chat). Build this
  only once real context growth is actually observed as a problem in practice, at which point:
  keep ONE live process, have the app send `/clear` in-place after an idle gap (do NOT
  tear down/respawn his pty on a timer — that breaks `--resume`, drops in-flight relays, needs a
  new "dormant" UI state, and doesn't even solve the underlying problem since a single long
  sitting can still auto-compact). Note: `/clear` and its "safe to continue" signal
  (`SessionStart(source:'clear')`) are Claude-specific; Codex's equivalent (`/new`) has no
  equally reliable signal — moot for now per §3.3.
- **Deferred: inline provider/model-switch UI** (§3.8) — nice-to-have, ships whenever convenient;
  the underlying relaunch-path bug fix does not need to wait for it.
- **Deferred: task decomposition/fan-out** (one request → multiple agents/projects) — v1 is
  single-target only (§3.1).
- **Deferred: proactive/autonomous behavior** — Arceus only ever acts because the user asked him
  to (directly, or via the picker); no unprompted relay/spawn/reporting.

## 7. Recommended v1 implementation scope

Putting §3 and §6 together, the coherent thing to actually build first:

1. `poke-ask` + `poke-spawn` + migrated `poke-relay` — async (fire-and-return-immediately),
   UDS-socket pattern extending `poke-delegate`, with the answer/outcome delivered as an injected
   follow-up message into Arceus's pty.
2. `roster.json` extended with a workspaces registry block + `lastDispatch` per entry.
3. Persona composed once at the `PtyManager.spawn` choke point (all three Arceus spawn paths),
   HARNESS.md excluded.
4. Permission-allow rules for the three new tool commands + the Arceus-identity guard.
5. The dispatch/reuse-vs-spawn/ambiguity behavior described in §3.1, driven by Arceus's system
   prompt plus the new tools.
6. The rule-based ambient one-liner + hidden details board (§3.6).
7. The visual redesign (§3.7) — full-bleed galaxy backdrop, HUD overlay layout, real design
   tokens — including porting the improved backdrop into the real `nebula.ts`.
8. The relaunch-path provider/model bug fix (§2/§5), independent of everything else.

Explicitly NOT in this scope: Codex-as-Arceus tool support, the JSONL log, the `/clear` lifecycle,
task decomposition, proactive behavior, the inline provider-switch UI (can follow later).

## 8. Open, low-stakes implementation-time details (not design gaps)

These don't need a decision now — reasonable to leave to whoever implements, with review before
merge:
- Exact wording/voice of Arceus's persona system prompt text for the new tool-calling behavior.
- Exact JSON schema field names for the roster.json workspaces block / `lastDispatch`.
- Exact phrasing the app uses when injecting the user's picker answer into Arceus's pty (e.g.
  does it read as a plain typed message, or a lightly structured one).
- Exact permission-allow rule syntax/prefix matching for the new `poke-*` wrapper commands.
