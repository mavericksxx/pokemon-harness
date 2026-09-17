---
title: HARNESS.md
order: 16
---

`HARNESS.md` is the harness's own instructions file — its equivalent of a
project `CLAUDE.md`, but owned by the app rather than whatever project
you're pointed at. It's seeded once, the first time it's needed, to
`<harness home>/HARNESS.md`, and never overwritten after that: edit the file
directly to retune how every session the harness launches behaves, and new
sessions pick up the change on their next start. The bundled default covers
working through subagents and delegates, model choice, the advisor consult
rule (see [Advisor](/docs/advisor/)), and cross-session coordination and
commit hygiene.

A topbar `harness.md` chip appears whenever the setting is on (it's on by
default) — click it to open the file directly. The chip simply renders
nothing when the setting is off, so it never takes up topbar space for
people who don't use it.
