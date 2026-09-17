---
title: Cost tracking
order: 11
---

Every `claude`-provider session's dollar cost and token counts are computed
locally from the CLI's own transcript files
(`~/.claude/projects/<munged-cwd>/<session-id>.jsonl`) — nothing is sent
anywhere to compute this. A cost watcher tails each tracked session's
transcript (event-driven via a filesystem watch, with a slow poll underneath
as a fallback), summing token usage off assistant turns on the session's
main chain, and the running total shows up on the session's own roster card
and focus header as it updates.

The menu-bar popover (see [Menu bar](/docs/menu-bar/)) adds a 30-day view: a
cost-history sparkline built by a separate scan over the whole
`~/.claude/projects` tree, run in its own short-lived helper process (a real
scan can burn several seconds of CPU-bound parsing — too heavy for the main
process's own thread) and cached with a TTL rather than re-run on every
popover open. Unlike the per-session watcher, the 30-day scan counts
subagent turns too, since excluding them would badly understate real total
spend for a workflow that runs almost everything through subagents.
