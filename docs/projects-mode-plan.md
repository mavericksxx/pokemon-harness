# Projects mode — design plan

Status: **design exploration. Core shape decided 2026-09-17; not implemented.**

**This file is a temporary planning artifact.** Delete it once §8 has been built and merged — the
content should live on as code, git history, `CHANGELOG.md` and `BACKLOG.md`.

> **Rewritten 2026-09-17.** The first draft of this document was built on two false premises and
> is preserved only in git history. It assumed (a) that an Agent-tool subagent is invisible to the
> garden, and (b) that the feature is fundamentally about parallel execution. Both were wrong —
> see §3 and §4. The rewrite is substantially smaller than what it replaces.

---

## 1. What this actually is

Not an orchestration feature. A **context** feature.

The user's own description of the problem:

> "Sometimes when I'm working on something, I have a bunch of ideas that clash with each other.
> Instead of sending different ideas to different sessions, I want to talk to just one agent. I
> tell it about idea A, and while I'm working through idea A I give it some context of idea B,
> then I go to idea C, then I come back to idea A and give it more context of B, then I go to idea
> D — and it basically knows everything about A, B, C and D."

So: **one long-lived conversation holding several live threads of intent at once**, fed
fragmentary, out-of-order input. Work happening in parallel is a downstream consequence, not the
goal — and the parallel-execution machinery already exists (§3).

This matches Anthropic's own framing of Projects more closely than the first draft did:

> "A project is one ongoing conversation where Claude coordinates a stream of related work for
> you."

and, on input:

> you paste bug reports, stack traces, or task lists "as they arrive, in any order."

## 2. Prior art

Anthropic's redesigned Projects (announced 2026-09-17; `claude.com/blog/projects-redesigned`,
`code.claude.com/docs/en/claude-projects`): a persistent **coordinator** conversation that starts
a **thread** per task, each "a separate cloud session with its own context window ... on its own
branch", reporting back a summary. The coordinator "sees what threads report back, not every step
they take." Shared state: project instructions (≤16,000 chars), project memory (a Claude-written
`MEMORY.md` every new thread reads on start), a Library, repos, a cloud environment. **Cloud only**
today; local execution "coming very soon", undated.

Their contrast table is useful to us: **agent teams** = one session spawning teammates for a
single task, ending when it ends; **agent view** = a dashboard of local sessions, "it has no
coordinator". Projects is the long-running one. In that taxonomy Arceus is agent view; what this
document describes is the coordinator.

Nobody else has the coordinator object. Cursor (Cloud Agents, Agents Window, Plan Mode), OpenAI
Codex, and GitHub Copilot all do "the user manually launches N parallel agents." The closest
structural analogue is Cognition's "Managed Devins", and that reads task-bounded.

Sourcing caveat: the announcement tweet was unfetchable (402 direct, 403 via mirror); the docs and
blog are matched to it by exact date and topic. Codex and Devin claims are secondary-sourced.

## 3. What already works today — verified, not assumed

**Agent-tool subagents are already visible Pokémon.** `hookRouter.ts` emits `spawn` / `correlate` /
`end` battle signals off the hook stream; `AgentRosterCard.tsx:309` renders per-parent subagent
card disclosure; battlers carry `parentId` (`store.ts:50`). A fan-out today produces walkers,
battles, and roster cards without any new plumbing.

**The completion signal for those children already exists.** `TaskNotificationWatcher` tails a
session's transcript for its **own** Agent-tool subagents' `<task-notification>` lines — captured
empirically against the real CLI, documented at length in that file's header. It fails only for
_sibling sessions_, which is what the first draft wrongly proposed to build.

**Lane selection partly exists.** The Agent tool takes a per-dispatch model, so haiku/sonnet/opus
are already selectable. **Luna cannot be a subagent** — GPT-5.6 via Codex needs a real session,
which `poke-delegate` already spawns as a tracked walker with its own battler.

**Arceus v2 shipped** (`CHANGELOG.md` v1.19.0): `poke-ask` / `poke-spawn` / `poke-relay` over the
`poke-delegate` UDS pattern, fire-and-return-immediately with the answer injected back as a fresh
pty message; `roster.json` with a workspaces registry and `lastDispatch`; persona composed at the
`PtyManager.spawn` choke point; the Hall of Origin UI.

Note on `docs/arceus-v2-plan.md`: it is built, but **do not delete it yet** — 47 comments across 22
source files cite it by path (`hookBridge.ts:87`, `pty.ts:312`, `arceus.ts:67`, …). Keep it as a
design record, or sweep the citations in the same change. Its outstanding deferrals are proactive
behavior and the `/clear` context-reset lifecycle.

## 4. What the first draft got wrong

Recorded so the same ground isn't re-covered:

- **"Children must be real sessions or they're invisible."** False (§3). This premise drove
  worktree-per-child spawning, `leadParentId`/`taskId` pointer fields, the N-concurrent-adoption
  species-collision fix, and most of the lifecycle hazards. All unnecessary for the default case.
- **"The completion signal is shipped, needs wiring."** Backwards. It is shipped _for own
  subagents_ (the case we actually want) and absent _for siblings_ (the case the draft invented).
  The whole `REPORT.md`-file-watching mechanism is unnecessary.
- **The trust-dialog spike.** Only arose because children were to be fresh CLI processes in
  never-seen directories. Subagents run in-process; there is nothing to verify. (Still true and
  worth remembering _if_ real-session children are ever added: trust is per-directory in
  `~/.claude.json` under `projects["<path>"].hasTrustDialogAccepted`, and there are zero worktree
  entries today despite agents having worked in worktrees.)
- **Parallel execution as the point.** §1.

Still correct and carried forward: the lead is not Arceus (§5.1), the lead never writes code, the
`isArceus`-keyed spawn gates make promotion a respawn (§5.1), and the widened trust guard needs
`parentAgentId` threaded through `PokeAskNotice` (§7).

## 5. The design

### 5.1 The lead

**Decided: a designated Pokémon session, not Arceus.** Arceus is a workspace-agnostic singleton
whose Codex form cannot reach the `poke-*` tools at all (spike 2b: `EPERM` under
`-s workspace-write`). A lead is an ordinary `claude` pty in a real cwd with the full tool surface.
Arceus stays the cross-project router; a lead owns one project's ideas. Both can exist at once.

**Decided: scoped to project root, not workspace.** `workspaceTypes.ts:19` already says a
workspace "isn't strictly one repo (any session's cwd can differ)", and the user routinely spawns
agents into different folders from one open garden. Project root = `git rev-parse --show-toplevel`
of the session's cwd, resolved at spawn, falling back to the literal cwd for a non-repo. One lead
per project root; two leads in one garden on different folders is explicitly allowed.

**Decided: settable at spawn time (dialog checkbox) and by promoting an existing session.**

**Promotion is a respawn, not a flag flip.** Three gates key on `opts.id === ARCEUS_SESSION_ID`
_inside_ `PtyManager.spawn` and run exactly once: the poke-tools PATH prepend (`pty.ts:483`),
`POKE_TOOL_PERMISSION_RULES` in the per-session settings file (`pty.ts:333`), and the composed
system prompt (`pty.ts:393`). `SpawnPtyOptions` (`shared/types.ts:5`) has no role field. So:

- `SpawnPtyOptions` must carry a **role**, passed on every spawn path — including
  `sessionRespawn.respawnSession`, which rebuilds options from the record
  (`sessionRespawn.ts:62-70`) and would otherwise drop it on relaunch. Same class of bug as the
  Arceus provider/model relaunch bug already fixed once.
- Promotion of a live session = respawn with `--resume <claudeSessionId>`, preserving the
  conversation (`recreateTerminal` / `tryResumeArceus` already do this).

**`HARNESS.md` must be excluded for a lead.** Forced, not optional: `pty.ts:354` appends
`--append-system-prompt-file <HARNESS.md>` to every non-Arceus, non-delegate claude session, and a
second such flag is last-wins (`shared/arceus.ts:181`). The choke point needs a general
**"compose one file per role"** step, not another `if` branch.

**The lead never writes code.** It holds context, routes, proposes, dispatches, and reads results.

### 5.2 Idea files — the core mechanism

**This is the feature.** Everything else is support.

Each live thread of intent gets a file: `<project state dir>/ideas/<slug>.md`, holding what the
idea is, everything the user has said about it, decisions made, open questions, and current state.

When the user says something, the lead **appends to the relevant idea file before responding**. The
file, not the transcript, is the durable record.

**Why this and not just a long conversation — the problem that decides the feature.** A lead is
one `claude` session with a finite context window. Four ideas accumulating over days means
auto-compact eventually fires, and compaction is lossy in precisely the wrong way: the user would
be deep in idea D when the details of idea B quietly stop being real. It fails _invisibly_ — the
lead keeps answering confidently about B. A feature whose whole promise is "it knows everything
about A, B, C and D" cannot rest on the context window holding out.

Anthropic's design says the same thing by implication:

> "Threads compact automatically, and the conversation works from recent messages, recent threads,
> and project memory rather than its full history."

The transcript is deliberately not the source of truth there either.

Consequences that fall out of this, all of them desirable:

- **Compaction becomes survivable.** After a compact, the lead re-reads the idea files.
- **The lead becomes replaceable.** If its pty dies or the app restarts, a fresh lead reads the
  same files and is equally informed. State lives on disk, not in a process.
- **Children get real briefs.** A dispatched subagent is handed the idea's file, not a one-line
  task — which is most of what makes a fan-out produce useful work.
- **Per-project memory is no longer a separate feature.** The idea files _are_ it.

Open sub-questions in §9: exact location, whether resolved ideas are archived or deleted, whether
the user edits these files directly.

### 5.3 Routing

**Decided: the lead states its inferred idea and proceeds.** "Filing this under idea B." It calls
`poke-ask` only when genuinely torn between two live ideas.

This mirrors the workspace-routing behavior Arceus already ships, and it is the right default here
for a specific reason: the input this feature exists to support is fast and fragmentary, delivered
mid-thought. A picker on every message would tax exactly the thing being enabled.

A misfile must be cheap to correct — at minimum by saying so ("no, that was about C"), and ideally
by the UI showing which idea each message landed in.

### 5.4 When an idea becomes work

**Decided: the lead proposes when an idea looks ready; the user accepts or declines.** Ideas
accumulate as pure context until then.

This is Anthropic's "Suggested threads" pattern. Two things to get right:

- **Proposing is not dispatching.** The Arceus cycle's "no proactive behavior" rule stands — the
  lead never starts work unasked. A proposal is a question, and it costs nothing.
- **It must not nag.** "Looks ready" is a judgment the model will sometimes get wrong. It should
  propose once per idea per meaningful change, not on every turn, and a declined proposal should
  stay declined until the idea materially moves.

On acceptance, the lane picker (§5.5) opens.

### 5.5 Dispatch and lanes

**Decided: one modal, one row per child task**, each row a lane selector pre-filled with the lead's
suggestion. One interruption per request, and the shape of the fan-out is visible before it is
committed to.

This is the single biggest upgrade over today, where "always offer Haiku / Sonnet / Luna" is a rule
in `CLAUDE.md` that the orchestrator follows on the honor system with nothing enforcing it.

Execution itself is mostly already built (§3):

- **Claude lanes → Agent-tool subagents.** Visible walkers, working completion signal, per-dispatch
  model. Nothing new.
- **Luna lane → `poke-delegate`.** A real tracked session with its own walker. Already shipped.

A mixed-lane fan-out is therefore the default, not a scope increase — it is what happens today.

**Worktrees are not part of the default path.** A subagent shares the lead's cwd. If two children
would genuinely collide on the same files, that is the lead's problem to avoid when decomposing —
or a reason to use worktrees for that specific fan-out, decided per case rather than built into
the mechanism. Deferred (§7) rather than designed now.

### 5.6 Review

**Decided: the lead presents a summary. No in-app diff pane.**

Merging is out of scope for the default path, since subagents work in the lead's own tree — there
are no branches to merge. (The earlier decision "lead merges clean branches, escalates conflicts"
applied to the worktree design and lapses with it. If worktrees return, it returns with them.)

### 5.7 Blocked children

A subagent that needs a permission decision surfaces it through the parent, which is already how it
works today — no new mechanism.

Worth recording why the obvious cross-session version does not work, so it isn't re-proposed:
`InjectionQueue.submit` injects only into an `idle` target (`injectionQueue.ts:56`), and `flush`
requires the same (`:83`). A `blocked` session is not idle, so a relayed answer queues until the
block clears by other means — never, for a permission prompt. The class header says this is
deliberate: a permission prompt must never be auto-answered.

### 5.8 Making a lead visually evident

**Decided: a lead's card reads as elevated, clearly below Arceus.**

Constraint: `tokens.ts:84` calls gold "The app's ONE primary accent" and `:138` notes there is no
separate brand-gold token. A second accent colour would undo a deliberate design decision, so the
lead treatment is built from the existing gold grammar at lower intensity. Arceus keeps the top of
that grammar (full bezel, crest, ceremonial variant).

A mockup of three candidates against real token values is at `docs/mockups/lead-card.html`
(light/dark toggle). It surfaced a real conflict: **ordinary cards already paint a 3px left border
from `session.accent`** — six hues, one of them a few degrees from gold — so a gold left edge is
not a free slot. Corner accents are Arceus's own device and read as diminished-Arceus. The third
candidate uses a 2px gold rule under the kicker row, an axis nothing currently occupies, at the
cost of being subtle enough to lean on the "lead" pill.

Pending the user's pick (§9).

## 6. Security: widening the tool guard

The shipped guard is literally `parentAgentId === ARCEUS_SESSION_ID` (`hookBridge.ts:1183`).
Letting a lead call `poke-*` means widening it to "Arceus **or** a session currently flagged
lead" — a change to the trust boundary, not a rename. `shared/pokeTools.ts` is already honest that
this guard is "a discoverability boundary ... not real sandboxing against a hostile one."

- The check must read the **live** session record, which in main means `sessionRegistry`
  (`index.ts:792`), a renderer-pushed mirror refreshed per checkpoint. `HookBridge`'s existing
  `isKnownSession` is pty-level (`ptyManager.hasSession`), so this is a **new callback**.
- **A lead's own Agent-tool subagents share its `POKEHARNESS_AGENT_ID`** and therefore pass the
  guard. This is pre-existing (equally true of Arceus today), but it is now load-bearing, since
  children are subagents by default.
- **`PokeAskNotice` carries no requester id** (`shared/pokeTools.ts:73`) and `PokeAskModal.tsx:102`
  writes the answer to `ARCEUS_SESSION_ID` **hardcoded**; `armInitialTaskDelivery`'s give-up path
  likewise (`sessions.ts:311-318`). Without threading `parentAgentId` through, a lead's questions
  land in Arceus's terminal. Required work, not a detail.
- **The permission rule is unverified.** `hookBridge.ts:113-123` explicitly flags
  `Bash(poke-ask:*)` prefix-matching a bare PATH-resolved name as UNVERIFIED. If false, a lead
  with auto-mode off stalls on a permission prompt in a terminal nobody is watching. Verify once,
  empirically, before building on it.

## 7. Deliberately deferred

- **Worktree isolation per child** (§5.5) — only if collisions prove real in practice.
- **Real-session children** instead of subagents — the trade is steerability and restart-survival
  against significant plumbing. Revisit only on evidence.
- **Cross-session answer relay for blocked children** (§5.7) — needs a deliberate `InjectionQueue`
  change.
- **Proactive dispatch** — the lead proposes, never starts unasked.
- **Library / Routines** — the filesystem and `/loop` already cover these.
- **Cloud execution** — local is the differentiator.

## 8. v1 scope, in build order

1. **Role on `SpawnPtyOptions` + `SessionRecord.isLead`**, carried on every spawn path including
   respawn; project-root resolution; one-lead-per-root; promotion as respawn-with-`--resume`.
2. **Lead prompt composed at the `PtyManager.spawn` choke point**, `HARNESS.md` excluded, via a
   general one-file-per-role step.
3. **Idea files** (§5.2) — location, read-on-start, append-on-input, re-read-after-compact. The
   core of the feature; everything before it is scaffolding.
4. **Routing behavior** (§5.3) — prompt-driven, plus surfacing which idea a message landed in.
5. **Trust guard widened** (§6) + `parentAgentId` threaded through `PokeAskNotice` and the outcome
   paths. Verify the permission rule here.
6. **`poke-plan`** — the N-row lane modal, dispatching to Agent-tool subagents and `poke-delegate`.
7. **Readiness proposals** (§5.4), with the anti-nag rule.
8. **Lead visual treatment** (§5.8).

Items 1–4 are the feature. 5–8 make it good.

## 9. Open items

- **Idea-file location** — under the harness home (user-visible, survives a repo wipe) or in the
  repo (versioned, shareable, but pollutes the project). Leaning harness home, keyed on project
  root.
- **Idea lifecycle** — how an idea gets closed, and whether closed ideas are archived or deleted.
  Anthropic auto-resolves a thread after a week idle.
- **Does the user edit idea files directly?** They are plain Markdown on disk, so effectively yes —
  the question is whether that is an advertised affordance the lead must expect, or incidental.
- **Lead visual treatment** (§5.8) — pick from the mockup.
