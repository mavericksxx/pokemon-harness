---
title: Arceus
order: 8
---

Arceus is a permanent, gold-framed orchestrator: summon a real Claude (or
Codex) session that can hand work to any other session across every
workspace in the garden, not just the one it was summoned in. Summoning
replaces the garden view with the Hall of Origin — a full-bleed starfield
scene with Arceus floating at its center, cycling through its type-plate
formes, and a right-side HUD logging every dispatch and exchange.

Arceus's own dispatch policy: identify which workspace a task belongs to
(asking only when it's genuinely ambiguous between two or more real
candidates); if an idle agent already exists there, always offer a choice
between continuing it or spawning a new one — never assumed silently;
otherwise spawn directly. A relay to a specific already-running agent only
happens when the user explicitly asks for one.

Three tools carry this out, all real Bash-invoked commands, all
fire-and-return-immediately — Claude Code's own Bash tool can't block
synchronously waiting on an external event, so each one returns a short
acknowledgment and nothing more:

- `poke-ask` shows a picker in the UI with a question and a set of options;
  the user's answer is injected back into Arceus's own terminal as a fresh
  message once they respond.
- `poke-spawn` starts a fresh top-level session in a named workspace, the
  same as spawning one by hand; confirmation of which pokémon and session it
  became is likewise reported back into Arceus's own terminal, once the
  renderer has actually created it.
- `poke-relay` injects a message into another live agent's terminal,
  resolved by session id, title, or (if unambiguous) pokémon species, and
  delivered through the same idle-safety queue used everywhere else a
  message gets typed into a busy session — queued if the target isn't idle
  yet, delivered the moment it is. It never messages Arceus back; a failed
  resolution already shows in the command's own output before Arceus's turn
  ends.

Each tool takes exactly one target and must be invoked as a plain, bare
command — never chained with `&&`, piped, or given an env-var prefix — or it
can miss the app's permission allowlist and stall on a prompt nobody will
answer. None of the three exist when Arceus is running on Codex; that's a
sandboxing limitation, and Arceus is told to say so plainly rather than
pretend otherwise.

Provider and model aren't fixed at summon time: the Hall of Origin HUD has
an inline switch that reconfigures Arceus live — a cheap `/model <name>` for
a same-provider model change, or a full re-summon for anything bigger, such
as a provider change or any change involving Codex on either side.

See also [Advisor](/docs/advisor/) — a different, narrower review-gate role
every top-level session (not just Arceus) consults before big decisions.
