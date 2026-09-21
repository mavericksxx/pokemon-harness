# Shelved: delegation gate and session refresh

Tried on 2026-09-21, then reverted in full, because it was getting too complicated to ship with confidence. Nothing here was released. All the code is still in master's history (commits listed below), so any piece can be picked back up with `git show <hash>` or `git cherry-pick <hash>`.

This covers three separate problems that came up in one session. They are independent: any one can be revived without the others, though 2 and 3 interact (see "How 2 and 3 interact").

---

## 1. The orchestrator ignores the "delegate, don't code" rule on small tasks

### Problem

HARNESS.md tells the top-level session to act as an orchestrator: never write project code itself, always delegate to a subagent or a Codex delegate. It fails on small tasks. In a real case, a session asked to fix a two-line UI bug in another repo diagnosed it and just edited the file.

Why it fails: by the time diagnosis is done, the session is already holding the fix. Writing a delegation spec then costs more than typing the patch, so the patch wins. The rule only binds on large tasks, where delegating is cheaper anyway. In other words, it has teeth only where it isn't needed.

Contributing causes, from the session that broke the rule: nothing re-surfaced the rule at the moment of decision; the carve-out ("docs, changelog, backlog are yours") turned every task into a category judgment; and the routing question only fired once the session had *decided* to dispatch, which is the very decision that failed.

### What we built

The user's design: stop banning self-editing, and ban *silently deciding* to self-edit instead. The session must always ask, and "do it myself" becomes one of the options.

- **Prose** (`src/shared/harnessInstructions.ts`): any code change starts with a four-option `AskUserQuestion` — Haiku, Sonnet, Luna (via Codex), and "I'll do it myself (small change)". The session may self-edit only if the user picks the fourth. The carve-out became path-based (`*.md`, `CHANGELOG*`, `BACKLOG*`, git/release ops). A new bullet named the "it's only two lines" rationalization and scope creep.
- **Enforcement** (`src/main/hookBridge.ts`): the app already relays every Claude Code hook over a UDS. We added a decision inside that relay:
  - `PreToolUse` on `Edit`/`Write`/`NotebookEdit` is denied unless the caller is a subagent (the payload has a top-level `agent_id`), the path is allowlisted, or the session is unlocked.
  - `PostToolUse` on `AskUserQuestion` unlocks the session if the user picked the self-edit option.
  - `UserPromptSubmit` and `Stop` clear the unlock.
  - Enrollment is opt-in per session. It is tied to the same `wantsHarnessInstructions` boolean that decides whether HARNESS.md is injected, so enforcement can never be wider than the prose.

Commits: `5c04a68` (gate), `0785871` (hardening).

### Findings worth keeping

- **`AskUserQuestion`'s result shape, confirmed from a live transcript** (four real calls). It is a plain string holding the question text and **only the selected label**. Unselected options and descriptions never appear:
  ```
  Your questions have been answered: "Which lane should build this?"="Sonnet (Recommended)". You can now continue with these answers in mind.
  ```
  A second variant begins `The user answered: "..."="..."`. So match on `="<label>"`, not the bare label. A bare match would also fire if the model quoted the label in its own question text.
- **Answering an `AskUserQuestion` does not end the turn.** The tool result comes back mid-turn, so an unlock set on `PostToolUse` survives to the edit that follows it.
- **Subagent detection:** Claude Code puts a top-level `agent_id` on hook payloads for a subagent's tool calls and leaves it off for the top-level session (documented in `hookBridge.ts` from an earlier capture). The gate depends on this. If the CLI changes it, subagents get blocked and delegation breaks entirely. The recommended direction is to fail **open**.
- **The first cut was scoped too wide.** It gated every claude session with a settings file, which would have blocked Arceus and anyone with harness instructions turned off. Fixed by tying enrollment to `wantsHarnessInstructions`.

### Open issues, not resolved

- **Bash is not gated.** `sed -i`, heredocs and `git apply` all edit files freely. Worse, **Claude Code's own auto mode** (the app spawns with `--permission-mode auto`) tells the model to prefer Bash over Edit/Write for file changes. That instruction comes from the CLI, not HARNESS.md. The gate therefore covers the tool auto mode tells the model *not* to use. The user decided not to override the CLI's auto-mode instruction.
- **Plain-text loop:** if the model asks in prose and the user types "you do it", nothing unlocks. The hardened deny message names the tool and label to break this loop, but it was never tested live.
- **Never run end to end.** The gate typechecked and built, but no session was ever denied and then recovered.

Two advisor reviews (a "savage" Fable pass and a later one) are summarized in the commit messages above.

---

## 2. A session left running across an update keeps its old flags forever

### Problem

The "leave them running" quit path detaches a session to a keeper process (`src/main/ptyKeeper.ts`). On next launch, `sessionRespawn.ts` calls `tryReattach` first and reuses that process. A running process's command line can't change, so flags that `spawn()` gained in later versions never reach it.

A real case: this session had been reattaching since before v1.11.0, so it had **no `--agents` flag**. The bundled advisor subagent was silently missing, with nothing to explain why. Its argv was `claude --resume … --settings … --append-system-prompt-file …` with no `--agents`.

Note: the respawn path (`sessionRespawn.ts`) is already correct, since it goes through the same `spawn()` as a new session. Only the reattach shortcut is stale.

### What we tried, in order

1. **Auto-refresh** (`95ecd44`): stamp the app version into `KeeperMeta` at detach. On mismatch, `tryReattach` kills the orphan and returns false, so the session respawns with `--resume`. Gated on `canResume`, because without a captured `claudeSessionId` the respawn would start an **empty** conversation.
   - **Rejected by the user:** it kills sessions. "Leave them running" exists so sessions survive quit and keep working, and killing them on the next launch defeats that. **Hard requirement: the app must never kill a session as a side effect of anything.**
2. **Report-only chip** (`f58aa3c`): reattach always succeeds, and staleness is recorded as `staleArgv` and shown as a chip on the session card ("older session — restart to update") with a restart action the user triggers.
   - **The restart button was broken** (found by advisor review, confirmed in code). The handler called `respawnSession`, whose first step is `tryReattach`. A session showing the chip is already reattached, and its keeper keeps its socket and accepts a second client (`clients` is a Set). So "restart" just reattached again. It rebuilt the session from a meta file the first reattach had already deleted, which blanked cwd, command and provider. It also leaked a socket, and made the chip disappear as if it had worked.
3. **Working restart** (`5bbfe4b`): the restart skips reattach, then runs kill → wait for exit → resume.
   - `killAndAwaitExit` registers the exit listener before killing and waits up to 5s. On timeout it spawns nothing, so two processes never write one transcript (see the corruption note at `index.ts` ~937-953).
   - It prefers the conversation id seen live over the saved one. This uses a per-session map of the latest top-level `transcript_path` (never a subagent's).
   - It repaints the terminal afterwards. The new pty spawns at 100x30 into an xterm already at its real size.
   - **Known edge:** if the old process doesn't exit within 5s, `kill()` has already removed the session from the app, so you get a disconnected card rather than a restart.

### Findings worth keeping

- **`claude --resume` redraws the prior conversation in the terminal.** Verified with a real pty, though only on a one-turn conversation.
- **To test the chip, sessions must be detached by a different app version.** Same-version sessions carry a matching stamp and show nothing.
- The 5s-timeout disconnected-card edge above is unresolved.
- **Never tested live.**

---

## 3. After `/clear`, a restart resumes the wrong conversation

### Problem

Observed live: this session ran `/clear` and worked for hours in conversation `d88e1bb4`. On restart the app ran `claude --resume 8fe02779`, the conversation from **before** the clear. The user had to find the right one by hand. Nothing was lost, but it would happen on every restart, because the stale id is what's persisted.

### What we found

- **Root cause (partly inferred):** the persisted `claudeSessionId` came from the hook payload's `session_id`, which doesn't follow a `/clear`. After a clear the CLI process holds **both** ids. Its env had `CLAUDE_CODE_SESSION_ID=d88e1bb4`, while its background-task output still went to a directory named for `8fe02779`.
- **Ruled out by reading the code:** the event isn't dropped, and the id isn't failing to persist. `renderer/.../hookRouter.ts:339` is the *only* place `claudeSessionId` is written.
- **Not confirmed:** whether `session_id` on a `/clear` SessionStart is *stale* or merely *absent*. The fix is the same either way. No live hook payload was captured.
- **Precedent:** `src/main/costWatcher.ts` already hit the same `/clear` bug for its own tracking and fixed it by keying off `transcript_path`.
- The new transcript (`d88e1bb4`) records **no link back** to its predecessor. The app has to track the relationship itself.

### What we built

`5e8f32e`: derive the id from `transcript_path`'s basename, which is the exact file `--resume` reopens, falling back to `session_id`. An event with neither still never blanks an existing id. It was never verified live. The way to check is to `/clear`, confirm the persisted id matches the new transcript filename, restart, and confirm you land in the right conversation.

### Pre-existing risk found along the way (not fixed)

A nested `claude -p` run from inside a session inherits `POKEHARNESS_AGENT_ID` and fires its own `SessionStart`, which **overwrites the parent's persisted id**. This was true before any of this work. A suggested fix: ignore a `SessionStart` with `source === 'startup'` when an id is already set and there's no fallback shell (a real `/clear` sends `'clear'`, compaction sends `'compact'`).

---

## How 2 and 3 interact

The restart in (2) resumes whatever `claudeSessionId` is saved, so a `/clear`ed session restarts into the **wrong conversation** unless (3) is also in place. Even with (3), a session `/clear`ed *before* the fix has a stale id saved, and a reattached process never fires a `SessionStart` to correct it. That's why the working restart prefers the live `transcript_path`. **If you revive (2), revive (3) with it.**

## Side notes from the session

- **The macOS permission prompts** (Music, Downloads, network volumes) come from agent CLIs spawned as children of the app, which inherit its TCC identity. Because the app is ad-hoc signed (`build/afterSign.cjs`, `identity: '-'`), TCC keys grants to the binary's cdhash, and every release resets them. A Developer ID would make grants persist.
- **The harness-rule failure that started item 1** was hit again in this session: the orchestrator had to be reminded to present lane choices, and the advisor rule couldn't be satisfied until a fresh spawn restored `--agents`.

## Commit index

| Commit | What |
|---|---|
| `5c04a68` | Delegation gate: four-option question plus PreToolUse enforcement |
| `0785871` | Gate hardening: answer-form match, `!agent_id` unlock, clear on Stop, deny message, logging |
| `95ecd44` | Stale reattach: auto-refresh by killing (rejected) |
| `f58aa3c` | Stale reattach: report-only chip (restart button broken) |
| `5e8f32e` | `/clear` resume fix via `transcript_path` |
| `5bbfe4b` | Working restart: kill → await exit → resume, live transcript id |
| `61d3899`, `d9c60d1`, `1a8bfb1` | Changelog entries for the above |
