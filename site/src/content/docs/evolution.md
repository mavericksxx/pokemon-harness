---
title: Evolution
order: 1
---

A session always hatches at its picked line's base stage (picking Gengar in
the dialog starts you with Gastly, which evolves into Gengar on its own).
Only time spent in `working` status counts toward the thresholds — idle,
blocked, and wall-clock time do not. Branching lines (Eevee, Scyther, ...)
evolve into a random member of the next stage.

**Static (Gen 6-9, #650-1025) species only enter the garden by manual pick,
never at random.** This applies at every random-selection point: the picker's
random default only draws from the bundled 42 (all animated already, so
nothing to filter), and a branching evolution's random draw
(`randomAnimatedSpecies` in `dexData.ts`) excludes static targets before
picking — Eevee's random branch pool is Vaporeon...Glaceon, never Sylveon; if
every branch option is static, the line just stops evolving there. A
*linear* (non-branching) evolution is not a random pick at all, so it always
proceeds even into a static target once reached — Bisharp still evolves into
Kingambit on schedule. Either way, the static species is only reachable in
the first place because someone picked its line manually; the automatic
evolution is completing a choice already made, not making a new one.

One consequence worth knowing: the picker's inline chain note lists every
branch a line's data says exists, including static ones — e.g. Eevee's note
still says "...or Sylveon" and Scyther's says "...or Kleavor" — but the
random draw above will never land on that branch on its own. Reaching Sylveon
or Kleavor means picking them directly from the search results, not letting
Eevee or Scyther evolve unattended.

Defaults: 10 minutes of working time to reach stage 2, 30 minutes to reach
stage 3. Override for testing/demos with the `POKE_EVOLVE_SECONDS` environment
variable, `"<stage2>,<stage3>"` in seconds, set on the process that launches
Electron:

```sh
POKE_EVOLVE_SECONDS=20,60 npm run dev
```

Evolving plays a ~9s ceremony (flash-in, silhouette, an accelerating
old/new-form oscillation, a lock, a flash-out reveal) modeled on the games'
own. A third, optional value scales its real-time speed (authored timings
assume `1.0` ≈ 15s; the default is `0.6`) — useful for slowing it down enough
to catch a screenshot mid-effect:

```sh
POKE_EVOLVE_SECONDS=20,60,3 npm run dev
```
