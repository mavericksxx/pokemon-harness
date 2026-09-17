# Projects mode — design plan

Status: **design exploration, decisions locked where marked. Not yet implemented.**
Written: 2026-09-17.

**This file is a temporary planning artifact, not permanent project documentation.** Delete it
once §7 has been built, reviewed and merged — its content should live on as code, git history,
`CHANGELOG.md` and `BACKLOG.md`.

Companion note: `docs/arceus-v2-plan.md` is **built** — `CHANGELOG.md` v1.19.0 confirms both its
backend (`poke-ask`/`poke-spawn`/`poke-relay`, roster workspaces block, `lastDispatch`, persona at
the spawn choke point) and its frontend (Hall of Origin, `ArceusHud.tsx`, `PokeAskModal.tsx`)
shipped, including the inline provider/model switch. Its own header says to delete it once built,
but **do not delete it yet**: 47 code comments across 22 source files cite it by path
(`hookBridge.ts:87`, `pty.ts:312`, `arceus.ts:67`, …), and deleting it strands every one of them.
Either keep it as a design record or sweep the citations in the same change. Its outstanding
deferrals are **task fan-out** (this document), **proactive behavior**, and the **`/clear`
context-reset lifecycle** (that plan's §6).

---

## 1. What prompted this

Anthropic announced a redesigned **Projects** for Claude Code / Claude Desktop on 2026-09-17
(`claude.com/blog/projects-redesigned`, `code.claude.com/docs/en/claude-projects`). The user wants
the same core idea in Pokéharness: talk to one agent, have it split work across many agents
working in parallel, each visible as its own Pokémon.

### 1.1 What Projects actually is (confirmed from Anthropic's own docs)

> "A project is one ongoing conversation where Claude coordinates a stream of related work for
> you. You tell it what needs doing and it starts a thread for each task."

- **Coordinator** — the persistent project conversation. "Takes what you send, decides what
  becomes a thread, and keeps track of every thread it started. It sees what threads report back,
  **not every step they take**."
- **Thread** — "a separate cloud session with its own context window that does one piece of work
  on its own branch, opens a pull request when the work calls for one, and reports back to the
  conversation when it finishes." Threads may spawn their own subagents.
- **Shared state** — project instructions (author-written, ≤16,000 chars), project memory
  (Claude-written `MEMORY.md` + supporting files, read by every new thread on start), a Library of
  artifacts, repos, a cloud environment.
- **Cloud only today.** Local execution is "coming very soon", undated. "A local session can't be
  part of a project."
- Separate model + effort settings for coordinator vs threads (default: coordinator low effort,
  threads high).

Anthropic explicitly contrasts Projects with two adjacent features of their own, and both
contrasts matter to us:

- **agent teams** — one session spawning teammates for *a single task*; ends when that task ends.
- **agent view** — a dashboard of local sessions; "it has no coordinator."

Projects is the long-running, open-ended one. In that taxonomy, **Arceus is agent view** (global
status + routing, no per-project coordinator) and what we are building here is the coordinator.
They are different objects and should stay separate.

### 1.2 What competitors have

Cursor (Cloud Agents + Agents Window + Plan Mode), OpenAI Codex (cloud tasks + `AGENTS.md`), and
GitHub Copilot (parallel agent sessions, worktree-isolated, "fleet mode") all do *"the user
manually launches N parallel agents."* **None of them has a persistent coordinator conversation
that decides when to fan out.** The only close structural analogue found is Cognition's "Managed
Devins", where a main Devin "scopes the work, assigns each piece to a managed Devin, monitors
progress, resolves any conflicts, and compiles the results" — and that reads task-bounded rather
than open-ended.

Caveat on sourcing: the announcement tweet itself was unfetchable (X returned 402 direct, 403 via
mirror). The docs and blog post above are matched to it by exact date and topic — near-certain but
inferred. Competitor claims for Codex and Devin are secondary-sourced and flagged as such.

---

## 2. Why we are well positioned

The pieces Anthropic had to build in the cloud, we mostly already have locally and shipped:

| Projects concept | Pokéharness equivalent | State |
| --- | --- | --- |
| Project | `WorkspaceRecord` (`shared/workspaceTypes.ts`) | shipped |
| Coordinator | the lead Pokémon (§3.1) | **new** |
| Thread | a spawned session with its own walker | shipped (`poke-spawn`) |
| Thread on its own branch | git worktree per child | **new** |
| Thread → PR | branch + summary; no PR | **new** (§3.6) |
| "Reports back when it finishes" | — no usable signal exists (§3.5) | **new** |
| Project memory | `MEMORY.md` per workspace | **new** (§3.7) |
| Project instructions | `HARNESS.md` (global today) | shipped, needs per-workspace scope |
| Library | — | deferred (§8) |
| Routines | — | deferred (§8) |
| Cloud sandbox | the user's own laptop | not needed |

Three things Anthropic's design confirms about our own instincts, worth stating because each one
*reduces* what we have to build:

1. **Fan-out is the headline behavior**, not a nicety. `arceus-v2-plan.md` §6 deferred it; that
   was an under-scope. One request → several agents is the point.
2. **Summary-only fan-in is correct.** "It sees what threads report back, not every step they
   take." We do not need to stream child output into the lead's context — only a completion event
   carrying a summary. This is the single biggest simplification available. **The completion
   signal itself does not exist yet and must be built** — see §3.5, which is the single largest
   correction advisor review made to this plan.
3. **Worktrees are the local answer to sandboxed clones.** Anthropic's own docs list worktrees as
   the local-session equivalent of what each cloud thread gets for free.

Where we differ, we differ favorably: no cloud (their #1 announced gap), no 200-threads/day cap,
no "sandbox pauses between turns and can lose uncommitted changes" failure mode, and a lane picker
spanning vendors — Luna-via-Codex is something Anthropic structurally cannot offer.

---

## 3. Decided design

Every decision in this section was made explicitly by the user. Where a decision loosens an
existing rule or leaves a detail open, that is called out inline rather than smoothed over.

### 3.1 The lead is an ordinary session, not Arceus

**Decision: a designated Pokémon session becomes the lead for a workspace. Arceus is untouched.**

Rationale: Arceus is a singleton, workspace-agnostic, deliberately stateless (persona in argv,
nothing durable in the transcript), and Codex-Arceus cannot reach the `poke-*` tools at all (spike
2b: `EPERM` under `-s workspace-write`). Every projects-mode requirement — a durable per-project
memory, N in-flight children, worktrees — fights those constraints.

An ordinary session has none of them. It is a real `claude` pty in a real cwd with the full tool
surface: the Agent tool, `poke-delegate` for Luna, and its own Read tool for reports. Its
*behavior* is close to what a top-level orchestrator session already does under `HARNESS.md`.

It is also per-workspace rather than global, which is what "project mode" actually means. Arceus
stays the cross-project router; a lead owns one project's work. Those compose. Arceus plus a lead
is always fine — different levels.

**Shape:** add `isLead?: boolean` to `SessionRecord`, alongside the existing `isArceus` /
`isPlainTerminal` / `delegateParentId` flags. The session keeps its normal `workspaceId`.

**Decided: at most one lead per PROJECT ROOT, not per workspace.**

The scoping unit is the repo, not the garden. `workspaceTypes.ts:19` already says so outright — "a
workspace isn't strictly one repo (any session's cwd can differ)" — and the user routinely spawns
agents into different folders from within one open garden. The three things that actually conflict
between two leads are all properties of a repo, not a workspace: serialized merges into one
primary branch, single-writer `MEMORY.md`, and children dispatched onto the same files. Two leads
in the same garden working *different* folders share none of those.

So: **"project root" = the git toplevel of a session's `cwd`** (`git rev-parse --show-toplevel`,
resolved once at spawn; falls back to the literal cwd when it is not a repo). At most one lead per
project root, enforced at promotion/spawn time — promoting a second lead for the *same* root
offers to demote the first; a lead for a different root is simply allowed, silently, even in the
same garden. Everything else in this document that says "workspace" as a scoping unit means
project root: `MEMORY.md` (§3.7), worktree parentage, and merge serialization.

Workspaces remain what they are — the garden/visual grouping and the unit Arceus routes across.
They are just not the unit a lead owns.

**Decided: both a spawn-time checkbox and later promotion.** The New Session dialog gets a "lead"
option, and a roster-card action can promote an existing session.

**Correction from advisor review — promotion is a respawn, not a flag flip.** Three gates key on
`opts.id === ARCEUS_SESSION_ID` *inside* `PtyManager.spawn` and run exactly once: the poke-tools
PATH prepend (`pty.ts:483`), `POKE_TOOL_PERMISSION_RULES` in the per-session settings file
(`pty.ts:333`), and the composed system prompt (`pty.ts:393`). `SpawnPtyOptions`
(`shared/types.ts:5`) has no role field at all. A live session flipped to `isLead` gets none of
these. So:

- `SpawnPtyOptions` must carry a **role**, and every spawn path must pass it — including
  `sessionRespawn.respawnSession`, which rebuilds options from the record
  (`sessionRespawn.ts:62-70`) and would otherwise silently drop the role on relaunch. This is the
  same class of bug as the Arceus provider/model relaunch bug already fixed once.
- Promotion of a live session = respawn with `--resume <claudeSessionId>`, preserving the
  conversation. The mechanism exists (`recreateTerminal` / `tryResumeArceus`). Demotion is the
  same in reverse.

**The lead never writes code.** Decided. Its prompt is composed at the same `PtyManager.spawn`
choke point Arceus's persona uses. **`HARNESS.md` must be excluded for a lead** — this is forced,
not optional: `pty.ts:354` appends `--append-system-prompt-file <HARNESS.md>` to every
non-Arceus, non-delegate claude session, and a second such flag is last-wins
(`shared/arceus.ts:181`). The choke point needs a general **"compose one file per role"** step
rather than a third `if` branch, because children need a composed file too (§3.7).

**The lead never writes code.** Decided. It routes, dispatches, reads reports, merges, and writes
memory. Its system prompt is essentially today's `HARNESS.md` orchestrator section, composed into
the same single `--append-system-prompt-file` built at the `PtyManager.spawn` choke point that
Arceus's persona already uses (`pty.ts`). Note the documented last-value-wins collision: there
must be **one** composed file, never two `--append-system-prompt-file` flags.

### 3.2 Children are real sessions, never Agent-tool subagents

**Decision: every child is a real spawned session with its own walker and its own Pokémon.**

This was the crux question and it is settled. Invisible Agent-tool subagents would be cheaper and
would make fan-in trivial (the result returns into the lead's context directly), but they defeat
the premise of the app: the garden is the point. A child must be a visible, independently tracked
battler that can evolve, fight completion battles, and appear in the party rail.

Consequence: fan-in needs a real mechanism, because the lead cannot see a separate session's
output. See §3.5.

### 3.3 Task grouping

A fan-out needs an identity so the garden can show "these four walkers belong to one task."

**Proposed: pointer fields on children, plus the plan itself stored on the lead's own record.**

On each child:

- `leadParentId?: string` — the lead that spawned it.
- `taskId?: string` — the fan-out batch.

On the lead: `leadPlans?: Array<{ taskId, title, children: Array<{ id, lane }> }>`, stamped when
the user confirms the plan.

**Correction from advisor review — pointers alone are not enough, and `delegateParentId` is not a
clean template.** "3 of 4 done" needs to know N, and with pointers only, a child the user closes
(`stopSession` drops it from the array) silently turns that into "3 of 3". Storing the plan on the
lead gives N durably, persists through the existing checkpoint, and needs no new file.

`delegateParentId` also carries far more semantics than the card link this draft wanted to
"mirror": non-persistence (`ipc/sessions.ts:70`), kill-on-quit (`pty.ts:1131`), hidden-when-done
tabs (`TerminalDrawer.tsx:44`), the "done" roster section (`RosterStrip.tsx:117`), and the delegate
challenge battle (`GardenScene.tsx:693`). A Luna child will carry **both** `delegateParentId` and
`leadParentId`, and will not survive relaunch, while a claude child will. That asymmetry is real
and must be designed around, not inherited by accident.

### 3.4 Dispatch and the lane picker

**Decision: a single option-card modal, same feel as the picker in use today.**

Flow:

1. User briefs the lead in plain language.
2. The lead decomposes the request into N child tasks and proposes a plan, each child carrying a
   suggested lane (haiku / sonnet / luna / opus) and a one-line rationale.
3. It calls a new `poke-plan` tool, which fires and returns immediately — same constraint as every
   other `poke-*` tool, for the same reason (spike 1: Claude Code's Bash tool hard-refuses a long
   blocking wait; this is a product guardrail, not a timeout).
4. The app shows **one modal, one row per child task, each row a lane selector pre-filled with the
   lead's suggestion.** User adjusts and confirms, or cancels the whole plan.
5. The app creates a worktree per child, spawns each child session into it, and injects its task
   as the child's first message.
6. The app injects a confirmation back into the lead's own pty naming the spawned children — same
   async-answer mechanism `poke-ask`/`poke-spawn` already use.

**Decided: one modal, one row per child.** A single interruption per request, and the whole shape
of the fan-out is visible before it is committed to. Not N sequential modals.

N=1 is not a special case; it is a fan-out of one, and the same modal shows a single row.

`poke-spawn` (single, no worktree, no lane choice) stays as-is for Arceus. `poke-plan` is
additive.

### 3.5 Fan-in: how a child reports back

**Decided: the child writes a report file; the app watches for that file and tells the lead.**

**This is the largest correction advisor review made.** The original draft claimed the completion
signal was "shipped, needs wiring." It is not — there is no usable one:

- An interactive `claude` child **never goes `done`**. `hookRouter.ts:540` sets `idle` at the end
  of *every* turn; `done` (`terminalRegistry.ts:331`) means the pty exited. A child that asks a
  clarifying question on turn 1 emits the identical signal to one that finished its task.
- `TaskNotificationWatcher` tails a session's own transcript for **its own Agent-tool subagents**
  (`taskNotificationWatcher.ts:1-156`). It has no concept of a sibling session.
- Completion battles (`BattleManager.handleParentDone`, `queueDelegateChallenge`) fire for
  subagent battlers and for a *delegate* pty exiting. Neither is task completion.
- A Luna child does exit, so it *does* go `done` — a second, different channel from the claude
  case.

**Therefore: completion is defined as the report file appearing, not as a session status.** This
is lane-agnostic, which is the whole point — it works identically for a claude child and a Luna
child.

Mechanics:

- Each child is spawned with an instruction to write `REPORT.md` in its worktree when done: what
  it changed, what it did not do, anything the lead must decide.
- Main watches each live worktree for that file with `fs.watch` plus a slow poll as a safety net —
  the exact pattern `taskNotificationWatcher.ts:497-509` already uses for transcripts.
- On appearance, main tells the lead which child, which task, which branch, and the report path.
  The lead reads it with its own Read tool. No transport, no parsing, no context streaming.

**Transport into the lead: reuse `PokeRelay.submit`** (`main/pokeTools.ts:101-113`) — main-side,
idle-safe, already shipped, with whitespace collapse and a 4000-char cap that are both fine for a
pointer message. Do **not** copy `adoptPokeSpawn`'s direct `writePty` (`sessions.ts:369-374`),
which can type into a pty mid-turn.

Failure cases that must be handled explicitly, not discovered later:

- **Exited without a report.** Now cleanly detectable as the complement of the above: a Luna child
  that goes `done` with no report, or a claude child `idle` for N minutes with no report. The
  message to the lead must say so plainly rather than pointing at a file that isn't there.
- **Report arrives after the lead's pty died.** `InjectionQueue.flush` drops a queue outright once
  its target is `done` (`injectionQueue.ts:78`), so the report is silently lost. This path must
  surface to the user as a notification instead of vanishing.
- **N reports landing at once.** Batch into one injection rather than N.

### 3.6 Review and merge

**Decision: the lead presents a summary; there is no in-app diff pane.**

**Decision: the lead merges conflict-free branches itself and escalates conflicts to the user.**

Note explicitly: this loosens an existing rule. `HARNESS.md`'s orchestrator section and the
project's own `CLAUDE.md` both treat merging as the human's step. The user moved that to the
in-app lead knowingly. The residual risk is real and should be stated in the lead's own prompt: a
conflict-free merge is not a correct merge. If this proves uncomfortable in practice, the natural
add-on is a dedicated reviewer child that reads the combined diff before anything lands — noted
here so it is not re-derived later.

Mechanics: each child works on `worktree-lead-<taskId>-<n>`; the lead merges each into the project
root's primary branch in completion order. On conflict it stops, leaves the branch unmerged, and
reports which files conflicted.

**Corrections from advisor review:**

- **The app creates worktrees, not the lead.** §3.4 step 5 and the original §3.1 contradicted each
  other. It has to be the app: main needs the worktree path *before* it can spawn the child's pty.
  So main-side `git` via `child_process`, using the user's resolved shell PATH.
- **Non-repo project roots must be handled.** `WorkspaceRecord.primaryFolder` is explicitly not
  guaranteed to be a repo (`workspaceTypes.ts:19`), and a session's cwd may not be one either.
  Fallback: spawn in place with no isolation, and say so plainly rather than failing obscurely.
- **Do not merge in the user's own working tree.** The project root is where the user's own
  session and uncommitted work live; `git merge` there against a dirty tree fails or entangles
  their WIP. Merge in a dedicated worktree, or refuse and escalate when the tree is dirty.
- **Worktree teardown needs an owner.** §5 admitted this was unassigned; the stale
  `.claude/worktrees/` entries in this repo are what unowned looks like. Assign it: the lead runs
  `git worktree remove` as the final step of a merge it completed. **Decided.** A conflicted or
  unmerged branch keeps its worktree, so it stays available to inspect.

### 3.7 Per-workspace memory

**Decision: the lead is the only writer, and it writes on child completion.**

Verified: **nothing like this exists today.** The date-partitioned folders the user remembered are
cost history (`costHistoryScan.ts` keys days as `YYYY-MM-DD`) — spend tracking, not agent memory.
No branch, no commit, nothing on disk. The *intent* is there though: `harnessHome.ts` already
creates an empty `agents/` directory documented as "reserved for a future phase (per-agent memory
and inboxes)", and `~/PokemonHarness/agents/arceus/` currently holds only `roster.json`,
`summon.json`, `SYSTEM.md`.

**Shape:** keyed on **project root, not workspace** (§3.1) — two leads in one garden on different
folders must not share a memory file. `<harness home>/projects/<slug>/MEMORY.md`, where `<slug>`
is derived from the project root path (basename plus a short hash of the full path, so two repos
with the same basename don't collide). Follows the same user-visible-on-disk principle
`workspaces.json` already does.

The lead appends to it after reading a child's report. Every child spawned against that root gets
a pointer to it on start.

**Correction from advisor review — the delivery mechanism differs by lane.** For a claude child
the pointer goes in the composed system-prompt file, which means children need role-aware
composition too (§3.1's "one composed file per role"). For a **Luna child it cannot**: `isDelegate`
spawns are excluded from instruction files entirely (`pty.ts:354`, `:438`, `:472`), so the pointer
has to be inlined into the prompt text itself.

Single-writer is deliberate: it avoids concurrent-write races with no locking, and it avoids the
bloat that comes from four agents each journalling their view of the same task. It matches
Anthropic's model, where memory is coordinator-authored and thread-read.

### 3.9 Making a lead visually evident

**Decided: a lead's card must read as distinct at a glance — clearly elevated, clearly not Arceus.**

Constraint that shapes this: the app was deliberately pared back to **one accent**. `tokens.ts:84`
calls gold "The app's ONE primary accent", and `tokens.ts:138` notes there is no separate brand
gold token because gold *is* it. Introducing a second accent colour for leads would undo that on
purpose, so the lead treatment should be built from the **existing gold grammar at lower
intensity**, not a new hue.

Arceus already occupies the top of that grammar: his own `ArceusRosterCard` with a full gold bezel
and a crest `::after`, plus the ceremonial `medium` variant in terminal mode. A lead must sit
visibly below that.

**Decided: mock it up first**, against the real design tokens, the same way the Hall of Origin
redesign was settled — then pick. The starting proposal below is the one to beat, not the answer:

- A **hairline gold left edge** on the roster card — a 2–3px vertical rank bar, using the same
  hard-edged, zero-radius, no-blur grammar as the garden bezel. Reads as "elevated" without the
  full frame Arceus gets.
- A small **"lead" pill** in the card's kicker row, in the same `JetBrains Mono` treatment the
  app already uses for status/technical strings.
- Its children rendered beneath it with the existing **"↳ <parent title>"** parent-link treatment
  `delegateParentId` already drives in `AgentRosterCard.tsx`, so a fan-out reads as one visual
  group in the rail for free.
- Optionally a subtle garden marker on the walker itself. Lower priority than the card, and it
  should be genuinely subtle — the garden already carries battles, evolutions and bubbles.

Explicitly **not**: a gold bezel, a crest, a ceremonial card variant, a warp view, or any second
accent colour. Those are Arceus's, and the distinction between "the god Pokémon" and "a lead"
should stay obvious.

### 3.8 Blocked children

A child can stall on something only the user can resolve — a permission prompt with auto-mode off,
or a genuine clarifying question. Its walker flips to `blocked` and it sits there.

**Decision: surface it to the lead and let the user answer there — but keep today's behavior as
the baseline and do not over-build.** The user notes this rarely fires in practice.

Anthropic draws the opposite line (telling the coordinator "go ahead" explicitly does *not*
unblock a thread; you must answer inside it). We can do better because `InjectionQueue` can
already write into any session's pty, so the answer can route back down. But that makes the lead a
middleman, which introduces a real failure mode: a relayed answer can be wrong, and a relayed
permission prompt can be rubber-stamped.

**Correction from advisor review — the obvious MVP is a no-op.** `InjectionQueue.submit` injects
only when the target is `idle` (`injectionQueue.ts:56`), and `flush` requires the same
(`injectionQueue.ts:83`). A `blocked` child is not idle, so a relayed answer queues until the block
clears by other means — i.e. never, for a permission prompt. The class header says this is
deliberate: a permission prompt must never be auto-answered.

So relay-the-answer-down does not work without changing that guarantee, which should not be
changed casually.

Minimum viable version, consistent with "don't over-build": the lead is *told* a child is blocked
and on what, and the app surfaces it — the user answers in that child's own terminal. This is
Anthropic's line too, and it costs nothing. Routing answers back down is a genuine follow-up
requiring a deliberate `InjectionQueue` change, not a v1 freebie. Revisit only if it fires often
in practice.

---

## 4. What is genuinely new vs reused

Reused as-is: the UDS socket transport and its env-var auth model (`hookBridge.ts`), the
fire-and-return-immediately tool convention (`shared/pokeTools.ts`), `poke-relay`, the
`PokeAskModal` visual grammar, `InjectionQueue`, `TaskNotificationWatcher`, completion battles,
the persona composition choke point in `pty.ts`, `WorkspaceRecord`, and the `delegateParentId`
roster-card parent-link treatment.

New:

1. `isLead` on `SessionRecord` + promotion UI + one-per-workspace enforcement.
2. The lead's composed system prompt (orchestrator rules, never writes code).
3. `poke-plan` — the fan-out tool and its N-row lane modal.
4. Worktree creation/teardown per child.
5. `leadParentId` / `taskId` / `taskTitle` and the garden's task grouping.
6. The completion → report → inject-into-lead fan-in path.
7. `<harness home>/workspaces/<id>/MEMORY.md` and its read/write wiring.
8. Merge-clean / escalate-conflict behavior in the lead's prompt.

### 4.1 Security note that must not be glossed

The shipped guard is `isFromArceus(parentAgentId)` — literally `parentAgentId ===
ARCEUS_SESSION_ID` (`hookBridge.ts`). Projects mode requires widening it to "Arceus **or** a
session currently flagged `isLead`". That is a real change to the trust boundary, not a rename.

`shared/pokeTools.ts` is already honest about what this guard is: "a discoverability boundary
against an ordinary session accidentally reaching a tool meant only for Arceus, not real
sandboxing against a hostile one." Widening it grows the set of sessions that can spawn other
sessions and type into their terminals.

**Corrections from advisor review:**

- The check must read the **live** session record, which in main means `sessionRegistry`
  (`index.ts:792`) — a renderer-pushed mirror refreshed per checkpoint. `HookBridge`'s existing
  `isKnownSession` is pty-level (`ptyManager.hasSession`), so this is a **new callback**, not a
  widening of that one.
- The inherited-env hazard is **already true for Arceus**: a lead's own Agent-tool subagents run
  inside the lead's process and share its `POKEHARNESS_AGENT_ID`, so a subagent's Bash call passes
  as the lead. App-spawned children get their own id (`pty.ts:337`, `index.ts:408`) and are fine.
  This is a pre-existing property of the trust model, worth stating rather than discovering.
- **`PokeAskNotice` carries no requester id** (`shared/pokeTools.ts:73`), and `PokeAskModal.tsx:102`
  writes the answer to `ARCEUS_SESSION_ID` **hardcoded**; `armInitialTaskDelivery`'s give-up path
  does the same (`sessions.ts:311-318`). Widening the guard without threading `parentAgentId`
  through those notices would route a lead's questions and outcomes into Arceus's terminal. This
  is a required part of the work, not a detail.
- **The permission rule is still unverified.** `hookBridge.ts:113-123` explicitly flags
  `Bash(poke-ask:*)` prefix-matching a bare PATH-resolved command name as UNVERIFIED. If it is
  false, `poke-plan` in a lead with auto-mode off stalls on a permission prompt in a terminal
  nobody is watching. Verify empirically once, before building on it.

---

## 5. Lifecycle and concurrency — known hazards

Raised by advisor review against the real code. These are not open questions; they are things that
will break unless designed for.

**Lifecycle**

- **Lead pty dies** → a fallback shell takes over the same id, status goes `done`, `isLead` stays
  set, and every fan-in injection is then dropped silently (`injectionQueue.ts:78`). Needs a
  "lead gone, N children still running" surface.
- **App relaunch** → a claude child resumes via `--resume` into `record.cwd`, which is its
  *worktree* path. If that worktree was removed, `spawn` fails (`pty.ts:280`), the shell fallback
  fails too, and the session vanishes. Luna children are never persisted and are killed at quit.
  A mixed-lane fan-out therefore comes back **partial, with no explanation**.
- **Lead relaunch** must re-apply the role — the fix is `SpawnPtyOptions` carrying it on every
  spawn path (§3.1), not merely persisting `isLead`.
- **Demotion with children in flight** — guard revocation means an in-flight `poke-plan`
  confirmation can land after the lead lost its rights, with the spawn already underway. Define
  the outcome.

**Renderer/main round trip — `poke-plan` is a worse version of a problem `poke-spawn` already
solved.** `poke-spawn` is main-spawn → `poke:spawned` → renderer adopt → wait for `SessionStart` →
inject → write outcome (`sessions.ts:254-375`, `index.ts:455-494`). `poke-plan` is main → renderer
modal → user → renderer → main ×N (worktree create + spawn each) → renderer adopt ×N → N
`SessionStart` waits → outcomes. Concrete hazards at N≥2:

- **Species collision.** `pickFreeLine(takenLines())` is called *before* `await initShinyConfig()`
  and before `addSession` (`sessions.ts:330-338`), so two concurrent adoptions can pick the same
  line. Fix by picking all N synchronously at confirm time, or by moving the pick after the await.
- **The trust-this-folder prompt becomes the normal case.** Every new worktree is a directory
  Claude Code has never seen. The `SessionStart` gate exists precisely to dodge that
  (`sessions.ts:271-278`). Confirm empirically that `SessionStart` still fires once trust is
  granted — otherwise the task never lands and N give-up toasts fire at once.
- **Batch outcomes into one injection** into the lead, not N.
- **Partial spawn failure** mid-batch (`MAX_CONCURRENT_SESSIONS = 64`, `pty.ts:93`; a missing cwd)
  needs a defined outcome: roll back the batch, or report partial.

## 6. Deliberately deferred

- **Library / artifact store** — Projects has one; we have the filesystem. Revisit only if
  non-code output becomes common.
- **Routines / scheduled work** — `/loop` and cron already exist outside the app.
- **Proactive behavior** — still deferred, as in Arceus v2 §6. The lead acts because the user
  asked, never unprompted.
- **In-app diff review pane** — explicitly decided against for v1 (§3.6).
- **A durable `TaskRecord` registry** — §3.3's cheap pointer approach first.
- **Cloud execution** — not needed; local is the differentiator, not the compromise.
- **A reviewer child before merge** — the named fallback if §3.6's merge policy proves too loose.

## 7. Recommended v1 scope, in build order

Advisor review found the original ordering wrong: task-grouping fields are a prerequisite of the
dispatch tool (adoption must stamp them) and of fan-in (which needs to know *which* lead to inject
into), and the lead prompt depends on the role plumbing. Corrected order:

1. **Role on `SpawnPtyOptions` + `SessionRecord.isLead`** — every spawn path carries it, including
   `sessionRespawn`. Promotion = respawn with `--resume`. Project-root resolution and the
   one-lead-per-root rule (§3.1).
2. **Lead prompt composed at the `PtyManager.spawn` choke point**, `HARNESS.md` excluded, via a
   general "one composed file per role" step rather than another `if` branch.
3. **Trust guard widened** (§4.1) + `parentAgentId` threaded through `PokeAskNotice` and the
   outcome/give-up paths, so a lead's asks don't land in Arceus's terminal. Verify the
   `Bash(poke-plan:*)` permission rule empirically here.
4. **Task-grouping fields** — `leadParentId` / `taskId` on children, `leadPlans` on the lead.
5. **`poke-plan`** — the N-row lane modal, app-owned worktree creation, the non-repo fallback, the
   synchronous species pick, batched outcomes.
6. **Report-file-watched fan-in** via `PokeRelay`, including the no-report and lead-died cases.
7. **Merge policy** in the lead's prompt text, plus worktree teardown on successful merge.
8. **Lead visual treatment** (§3.9).

**Decided: mixed-lane fan-outs are in from day one.** A single batch may contain both claude and
Luna children. This is the cross-vendor capability no competitor has, and the user wants it at
launch rather than in v2.

It is also a deliberate scope increase, and the cost must be carried in v1 rather than discovered:

- **Two completion channels.** A Luna child exits and goes `done`; a claude child never does.
  §3.5's report-file trigger is what makes this tractable — it is the same for both — but the
  *no-report* fallback differs per lane (`done` with no report vs. `idle` for N minutes with no
  report) and both paths must be built.
- **Asymmetric relaunch.** Luna children are not persisted and are killed at quit (`pty.ts:1131`),
  while claude children resume. A mixed batch therefore comes back partial after an app restart.
  v1 must define and surface this — at minimum, the lead is told which children did not survive,
  rather than silently seeing a plan of 4 with 2 sessions.
- **Double parentage.** A Luna child carries both `delegateParentId` and `leadParentId` (§3.3);
  every consumer of `delegateParentId` (`RosterStrip.tsx:117`, `TerminalDrawer.tsx:44`,
  `GardenScene.tsx:693`, `ipc/sessions.ts:70`) must be checked against that combination.

**`MEMORY.md` (§3.7) moves to a follow-up.** Advisor's call, and it is right: it has no tested
mechanism, it needs the role-aware composed-file change for *children* (which item 2 only does for
leads), Luna children can't receive it the same way at all, and nothing else in v1 depends on it.
It is a clean second increment rather than a v1 risk. This does not reverse the user's decision to
have it — only its position in the queue.

Not in scope: everything in §6, and any change to Arceus.

## 8. Remaining open items

- **Lead visual treatment** (§3.9) — mock up two or three options against the real tokens, then
  pick. Everything else is decided.

All other decisions are recorded in §3 and §7: lead is not Arceus; lead never writes code;
children are real sessions; one lead per project root, not per workspace; both spawn-time and
promote-later; one modal with N rows; mixed-lane fan-outs from day one; summary-only review; lead
merges clean and escalates conflicts, removing the worktree on success; memory is lead-written on
completion (follow-up increment); blocked children surface without over-building.
