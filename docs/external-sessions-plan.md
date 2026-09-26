# External sessions — design plan

Status: **design agreed with the owner 2026-09-26, reviewed, and live test 1 settled (§6). Not implemented.** Build order is §7; it supersedes the sketch in §4 where they disagree.

**This file is a temporary planning artifact.** Delete it once built and merged — the content should
live on as code, git history and `CHANGELOG.md`.

---

## 1. What the owner wants

Continuity across surfaces. Claude Code sessions started in the Claude Desktop app (Code tab) or the
plain `claude` CLI should be visible in Pokéharness, previewable, and continuable here as a normal
session with a Pokémon. The owner only ever prompts from one surface at a time, but switches
freely — "at the end of the day it's just one chat".

Codex sessions are **out of scope** (Codex is only used for delegation).

## 2. Flow (agreed)

1. **Agent sidebar → "Other sessions"**, collapsed by default (persisted). Row: title, repo · branch,
   source badge (Desktop / CLI), last active, green dot when live somewhere.
2. **Click a row → read-only chat preview** in the terminal pane area (option A: a virtualized React
   list, not xterm). User prompts and assistant text as turns; tool calls collapsed to one line
   ("Edited src/foo.ts"). Header bar: title · repo (branch) · source · age · **[ Continue session ]**.
   - **The preview is always live**: every open re-reads the file; while open, it tails the
     transcript and appends new turns as they're written.
3. **Continue session** opens the existing new-agent dialog in continue mode: provider Claude Code
   (locked), cwd = session cwd (locked; if it no longer exists, warn and let the user pick), name =
   session title, model and auto-mode prefilled from session metadata (editable), Pokémon picker as
   usual, primary button reads **Continue**.
4. **On Continue**: spawn `claude --resume <id>` through the normal `PtyManager.spawn` path (hooks,
   harness instructions, agent id). It becomes an ordinary session and leaves the Other list. It
   stays listed in Desktop — same conversation id.
5. **Auto-reload when the conversation moves elsewhere.** A running `claude` process holds the
   conversation in memory and does **not** pick up turns another surface appends (confirmed, §6 test 1). When
   Pokéharness sees the transcript change from outside, and the session is **idle** (last turn
   finished, no draft typed in its prompt box), it re-resumes the session so the terminal redraws
   with the full chat. Owner approved this explicitly on 2026-09-26; it is scoped to catching up a
   conversation and does not overturn `f58aa3c` (no restarts to refresh flags).

**Defaults:** closing a continued session returns it to the Other list (never deleted). The list
hides subagent/sidechain transcripts, `sdk-*` entrypoints, and Pokéharness's own sessions.
Continued sessions do **not** get the 👾 title marker.

**Explicitly allowed:** continuing a session that is live elsewhere. No blocking, no fork prompt.

## 3. What the research established (2026-09-26, read-only)

- **One store.** CLI and Desktop both write `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
  (Desktop runs its bundled CLI locally, headless stream-json, `entrypoint:"claude-desktop"`).
  Directory names aren't reversible — read `cwd` from inside the file. Subagent transcripts are
  nested at `<uuid>/subagents/agent-*.jsonl`; skip them.
- **Cheap metadata.** First ~50 lines: `cwd`, `gitBranch`, `entrypoint`, `version`, first user
  prompt. Last 64 KB: `custom-title`, `ai-title`, `last-prompt` records (316/316 files had them
  there). Sidecar `<projectdir>/<uuid>/custom-title.json` (already handled by
  `src/main/sessionTitleWatcher.ts`).
- **Desktop metadata**: `~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_<uuid>.json`
  — `cliSessionId`, `cwd`, `title`, `model`, `effort`, `permissionMode`, `isArchived`,
  `lastActivityAt`. Join by `cliSessionId` for better titles/model/archived. Desktop itself lists
  outside sessions by scanning `projects/*/*.jsonl`, and "adopts in place" under the same id.
- **Liveness**: `~/.claude/sessions/<pid>.json` — `pid`, `sessionId`, `cwd`, `procStart`, `kind`,
  `entrypoint`, `status` (idle/busy/waiting), `updatedAt`. Desktop's processes register too.
  Desktop's recipe: pid alive + `procStart` matches + record < 24h old. `sessionId` equals the
  `--resume` argument.
- **The CLI does not refuse** `--resume` of a conversation held by another interactive process
  (only non-interactive holders block it).
- **No side-effect-free CLI viewer** (`--resume`/`--fork-session` write and fire hooks) → preview
  must parse JSONL ourselves. Sizes: median 282 KB, p90 3.6 MB, max 195 MB. Parse off the main
  thread, paginate from the end. Format is undocumented and spans CLI 2.1.20x–2.1.28x: tolerate
  unknown record types and bad lines.
- **Resume path exists**: `respawnArgs` (`src/main/sessionRespawn.ts`), `tryResumeArceus`
  (`src/renderer/src/arceus.ts`). `startSession` (`src/renderer/src/sessions.ts`) only builds fresh
  args — needs a continue variant (resume id, cwd, model, permission mode). **Correction from
  review:** the fix that follows `/clear` (`5e8f32e`) was reverted in `c5b4835`; HEAD still takes the
  id from `p.session_id` (`hookBridge.ts:1089`). It must be revived (§7 step 0).

**Reuse:** `costHistoryScan.ts`/`costHistory.ts` (child-process scan with cache), `costWatcher.ts`
(transcript tailing), `sessionTitleWatcher.ts`, `taskNotificationWatcher.ts` (parsing),
`RosterStrip.tsx` collapse pattern.

## 4. Build sketch

- **Main — `externalSessions.ts` + scan child process**: enumerate top-level transcripts, cache by
  (path, mtime, size), head/tail metadata read, sidecar title, Desktop join, exclude own ids,
  liveness from `~/.claude/sessions`. Refresh on section expand and on `fs.watch` of
  `~/.claude/projects`.
- **Main — transcript reader**: streaming parse into normalized turns, cursor-paginated from the
  end; a tail subscription for the live preview.
- **Main — outside-write detector** for continued sessions: transcript grew while our own pty had no
  turn in flight (our hooks saw no `UserPromptSubmit`), or the registry shows another live pid on
  the same `sessionId`.
- **IPC**: `externalSessions:list`, `:readTranscript(id, cursor)`, `:subscribe(id)`, `:continue`.
- **Renderer**: store slice + persisted collapsed flag; "Other sessions" section; `TranscriptView`
  in the drawer; continue-mode for `NewSessionDialog`; `startSession` continue variant; idle
  tracking (Stop hook seen, and no bytes typed since the last Enter) to gate auto-reload.

**Effort:** list + liveness + continue ≈ M; live chat preview ≈ M; auto-reload ≈ S–M. Overall M–L.

## 5. Risks

- Undocumented JSONL format may change under a CLI update → defensive parser, unknown records
  ignored.
- Model / permission mode may not survive `--resume` → pass `--model` / `--permission-mode`
  explicitly.
- A deleted cwd (Desktop worktrees) → fallback of `--resume <path>.jsonl` is unverified.
- Transcripts may reference Desktop-only MCP tools (`mcp__ccd_session__*`) absent here.
- Auto-reload restarts a process; the idle gate must be conservative, and a reload must never fire
  mid-turn or over a draft.

## 6. Live tests

### Result of test 1 (run 2026-09-26, CLI 2.1.283, owner-approved)

A throwaway conversation (Haiku, scratch folder) was told "deploy region is MANGO-1". An interactive
`claude --resume <id>` was opened on it; while it sat open, a second process ran
`claude -p --resume <id>` saying the region changed to PAPAYA-1. The open session was then asked for
the region: it answered **MANGO-1**. In the JSONL, the second process's user turn and the open
session's user turn have the **same `parentUuid`**: the conversation forked into two branches in one
file. The registry entry for the open session read `kind: interactive, status: idle,
entrypoint: cli` with the resumed `sessionId`.

**Consequences:** auto-reload is required, not optional. Without it, the next prompt typed in a stale
Pokéharness terminal silently forks the chat away from what Desktop shows. Test gotchas for re-runs:
strip inherited `CLAUDE_CODE_*` / `CLAUDECODE` env (a child marker turns transcript saving off), and
a new folder's trust dialog defaults to "No, exit".

### Remaining tests (owner, or orchestrator with approval)

1. ~~**Does a running session see another surface's turns?** Open a Desktop Code session; get its
   `sessionId` from `~/.claude/sessions/<pid>.json`. In a terminal, `cd` to its cwd and
   `claude --resume <id>`. Send a message in Desktop, then one in the terminal. Did the terminal
   show Desktop's turn? Does the JSONL's `parentUuid` chain branch?~~ **Done: no, and yes.**
2. **Does `--resume` redraw the full history?** Resume a long transcript; scroll to the top.
3. **Resume from another cwd**: from `/tmp`, `claude --resume <id>`, then
   `claude --resume ~/.claude/projects/<dir>/<id>.jsonl`.
4. **Registry after `/clear`**: compare `~/.claude/sessions/<pid>.json` `sessionId` with the newest
   `.jsonl` in that project dir.
5. **Model and mode on resume**: resume an Opus / auto-mode Desktop session; check `/model` and the
   mode indicator.
6. **Desktop after continuing here**: add turns in the resumed terminal, then open the session in
   Desktop. Do the new turns show? Does Desktop warn while the other process is live?
7. Does every line still parse after two writers (`jq -c . file >/dev/null`)? Any spliced lines?
8. What does a bare `--resume` append at startup with no input? (Detector baseline.)
9. Does Desktop keep one long-lived process per open session or one per turn? Does registry `status`
   reliably go busy → idle?
10. Is `entrypoint` present on every record?
11. Does `UserPromptSubmit` fire for slash commands and for task-notification-started turns?
12. Resuming while the other side is mid-tool-call: does the CLI write repair records?
13. Extend test 5 across an app restart, not only the first resume.

## 7. Review changes and build order (architect review, 2026-09-26)

Verdict was "proceed with changes". Accepted changes:

- **Outside-write detection** (replaces "transcript grew with no UserPromptSubmit", which fires on
  our own post-Stop records, slash commands, `/compact`, task-notification turns and our own resume
  and would loop):
  (a) primary: the `~/.claude/sessions` registry shows another pid (not our pty or keeper pid) on our
  `sessionId` that went busy → idle or exited since our last Stop;
  (b) secondary: a new human-prompt `user` record (not meta, tool_result, task-notification, command
  or compact summary) whose text matches no prompt our `UserPromptSubmit` saw, or a foreign
  `entrypoint`;
  (c) re-baseline after our own reload's SessionStart(resume);
  (d) circuit breaker: at most one reload per N minutes per session; log every decision.
- **Idle gate covers both sides.** Ours: status idle, no `awaitingSubagentIdle`, no bytes typed
  since the last Enter, no keypress in ~10s. Theirs: registry idle or gone, and transcript quiet for
  a few seconds (a reload mid-tool-call may write repair records and branch).
- **Reload = kill → await exit → resume.** `PtyManager.spawn` on a live id kills without waiting
  (`pty.ts:299`); revive `killAndAwaitExit` from `5bbfe4b` (5s timeout, spawn nothing on timeout).
- **Persisted `SessionRecord.continuedFrom`** (plus permission mode). Scopes auto-reload to continued
  sessions only (never native ones, per `f58aa3c`), disables the 👾 marker (keyed by conversation id,
  so a `/clear` inside a continued session still marks the new conversation), and survives restart.
  Set `claudeSessionId` at `addSession` time.
- **"Ours" filter** = live ids **plus** `custom-title.json` starting with 👾, so closed native
  sessions don't flood the list.
- **CostWatcher** reads a whole transcript synchronously on first registration
  (`costWatcher.ts:236,318-326`); a 195 MB continue would freeze main. Bounded tail read first.
- **Simpler plumbing:** async `fs/promises` scan with a concurrency cap (no child process unless
  measured jank); no recursive `fs.watch` on `~/.claude/projects` (refresh on expand, stat-poll
  ~10s while expanded; watch `~/.claude/sessions` for the live dot); preview reads backward in ~1 MB
  chunks and tails with CostWatcher's offset+carry; separate `previewExternalId` in the store (not
  `selectedId`, which is checkpointed).
- **Continue edge cases:** verify the transcript exists before spawning and use
  `waitAlive(RESUME_GRACE_MS)`; allow a different cwd only if test 3 shows the same file keeps being
  appended; note (don't silently drop) a boot-time record whose cwd vanished. Hide Desktop
  `isArchived` sessions by default.
- **Accepted costs:** each surface switch/reload is a prompt-cache miss (our system prompt differs);
  the orchestrator persona is injected into a Desktop conversation mid-stream; `cleanupPeriodDays`
  can delete a continued session's transcript.

**Build order (each increment ships on its own; `npm run dev` review with the owner before any
release):**

0. Prerequisites, each worth having alone: revive `5e8f32e` with a `source==='startup'` guard (and
   the nested `claude -p` overwrite fix); bounded initial read in CostWatcher; persist permission
   mode and pass resume flags in `respawnArgs`.
1. Read-only "Other sessions" list: scan, Desktop join, liveness dot, ours/archived exclusion,
   collapsed flag.
2. Continue session: dialog continue mode, `startSession` variant, `continuedFrom`, no 👾,
   transcript-exists and grace checks, cwd policy. Button on the row until the preview exists.
3. Chat preview: static with backward pagination, then live tail.
4. Detector in dry-run with a manual "Updated elsewhere — reload" chip using kill → await → resume.
5. Turn on auto-reload behind the full idle gate and circuit breaker once step 4's logs show no false
   positives.
