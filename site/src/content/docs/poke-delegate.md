---
title: Poke-delegate
order: 15
---

`poke-delegate` dispatches a real, independently-tracked Codex session from
inside another agent's own workflow — not the same as an agent just shelling
out to `codex exec` itself. Invoked as a bare Bash command
(`eval "set -- $POKEHARNESS_DELEGATE_CMD"; "$@" --cwd <dir> --label <name>
'<prompt>'`), it opens a genuine Codex session with its own tab and its own
walker in the garden, and returns almost immediately — it does not wait for
the delegate to finish. `HARNESS.md` (see
[HARNESS.md](/docs/harness-instructions/)) tells every orchestrator session
to prefer this over a Claude subagent that merely shells out to Codex
itself: the latter is a real added Claude-model cost with no coding value
(Codex still writes all the code either way) and produces no garden-visible
pokémon, where `poke-delegate` is a first-class app mechanism.

One limitation worth knowing: a delegate's pokémon is an ordinary
independent session walker, not a battle-manager battler — it never fights
or triggers a parent's mega evolution the way a `Task`-dispatched subagent's
roaming companion can.
