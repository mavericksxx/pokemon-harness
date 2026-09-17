---
title: Advisor
order: 7
---

The advisor is a second AI role the harness consults as a review gate — not a
battle or evolution mechanic. The bundled `HARNESS.md` (see
[HARNESS.md](/docs/harness-instructions/)) instructs every top-level session
to consult it — via `Agent({subagent_type: "advisor"})` — before committing to
an architecture decision, a data migration, an API design, or a refactor
touching 3+ files, and always once more before reporting any deliverable
done. The rule applies only to the top-level orchestrator session: a
subagent it dispatches is never told to consult the advisor itself, since
each nested consult is a real, separate cost that compounds fast under
fan-out.

The advisor is dispatched as a real Claude subagent (`subagent_type:
'advisor'`). Its default model is set in Settings → harness home → advisor
model; if you keep your own `~/.claude/agents/advisor.md` (user- or
project-level), that file's own `model:` setting takes over and the bundled
advisor is skipped entirely.

In the garden, a consult spawns a hovering companion beside the session it's
advising — always a Lake Guardian (Uxie, Mesprit, or Azelf), assigned
round-robin, wrapped in a lilac aura, tracking its parent for the duration of
that one `Task` dispatch. It never roams, never queues, and never enters a
battle; it despawns with a pokéball-recall animation once the consult ends.
The renderer's hook router tells the two kinds of `Task` dispatch apart by
the tool call's own `subagent_type` — `'advisor'` routes to the advisor bus,
everything else routes to the ordinary battle bus (see
[Subagent battles](/docs/subagent-battles/)).
