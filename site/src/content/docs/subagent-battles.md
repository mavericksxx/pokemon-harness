---
title: Subagent battles
order: 4
---

When a `claude` session's hooks (or, as a fallback, its terminal output —
` ● Task(` lines) show a `Task` tool call, the garden treats it as a
subagent spawn: a random ANIMATED Pokemon (excluding lines already in use by
a session or another battler, preferring bundled base-stage species) poofs
in far from the parent, a "!" pops over both its head and the parent's, and
then both walk toward each other and square off — the parent bottom-left on
its back sheet, the challenger top-right on its front sheet, gen5ani's own
native draw angles aiming them at each other with no mirroring needed. While
the subagent is active, the parent's own tool calls become alternating
attacks (lunge, hit-flash, floating "«Species» used «Tool»!" text); rapid
tool events coalesce into the current attack's combo counter instead of
queuing replays. Up to 3 concurrent subagents fan out around the parent
(more show as a "+N" badge); `SubagentStop` (or the parent going idle, in
regex-fallback mode) ends one with a poof, and the last one ending plays a
victory hop before the garden returns to normal. An evolution ceremony
triggered mid-battle waits for the current attack to finish, then runs to
completion before the battle resumes — the ceremony's own exclusivity is
never touched by the battle code.
