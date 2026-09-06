---
title: Shiny Pokemon
order: 2
---

Every session rolls shiny once, at creation, with default odds 1-in-64 —
independent of species, and kept for the session's whole lifetime, through
every evolution stage. Override for testing/demos with the `POKE_SHINY_ODDS`
environment variable (1-in-N; `1` means always shiny), set on the process
that launches Electron:

```sh
POKE_SHINY_ODDS=1 npm run dev
```

A shiny walker's first garden spawn plays a sparkle burst (a ring of 4-6
twinkling white/gold stars) and a floating "✨ Shiny!"; a small ★ badge marks
it on its session tab and, if that line is already taken, in the picker.
Showdown/Smogon ship no shiny sheets for the 42 bundled species, so a shiny
pick always fetches its sprite lazily — front and back, animated or static —
even for an otherwise-bundled species; a 404'd shiny front sheet falls back
to the normal sprite (logged), keeping the shiny flag and badge either way.
Wild subagent-battle challengers (see [Subagent battles](/docs/subagent-battles/))
roll shiny with the same odds and get the same spawn sparkle.
