---
title: Claude Code hooks (authoritative session state)
order: 3
---

For `claude` sessions specifically, the app wires Claude Code's lifecycle
hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `Stop`, `SubagentStop`) instead of relying solely on scraping
terminal text. On spawn, main writes a per-session `settings.json` (a temp
file, never touching your own `~/.claude/settings.json`) whose `hooks` block
runs a small generated shim (`<userData>/hooks-bin/cth-hook.cjs`, invoked
through a bundled-node launcher so it works even when `node` isn't on the
stripped `PATH` Claude runs hooks with). The shim forwards each hook's JSON
payload over a Unix domain socket to the main process
(`src/main/hookBridge.ts`), which relays it to the renderer over
`hooks:event:<sessionId>` IPC.

**Hooks are authoritative once they start flowing** for a session — the
renderer's hook router (`src/renderer/src/pty/hookRouter.ts`) drives
status/tool/station directly from hook events, and the regex parser
(`ptyParser.ts`) steps aside for that session. This is a *latch*, not a
short window: once a session's first hook fires, the regex parser stays out
of the way for the rest of that session's life unless hooks go quiet for 60
seconds straight (an old Claude Code version without hook support, or a
session that otherwise never fires one) — at which point the regex parser
resumes as a safety net.

**Fallback to the regex parser** happens automatically for:
- Non-`claude` providers (`codex`, `cursor-agent`) — hooks are Claude Code
  -specific, so these are always regex-driven, exactly as before.
- A `claude` session whose hooks have gone silent for 60+ seconds (see above).

The app never gates or denies a tool call at the hook boundary — hooks here
are observation-only, purely for state (no HITL/permission logic).

*Real-`claude` verification is pending a manual user test.* Everything above
was verified end-to-end by spawning a real session with a harmless long-lived
command in place of `claude` (so main still wires the real hook
settings/env) and invoking the generated shim directly with hand-written
fake hook JSON on stdin — i.e. exercising the exact shim → socket → main →
IPC → renderer path a real `claude` process would, without a real `claude`
binary in the loop.
