# backlog

**Open work now lives in [GitHub Issues](https://github.com/mavericksxx/pokemon-harness/issues).**
This file is a pointer. Completed work stays in [CHANGELOG.md](CHANGELOG.md), grouped by release.

Everything that was open here on 2026-09-03 was migrated to issues #1–#27 — nothing was dropped.

## rule of engagement

Ship the release in flight first, then resolve items **one at a time** unless a parallel fan-out is
explicitly requested.

## how the issues are organised

**Milestones** — [`v1.12.0`](https://github.com/mavericksxx/pokemon-harness/milestone/1) (fix what's
broken, finish phase F) · [`v1.13.0`](https://github.com/mavericksxx/pokemon-harness/milestone/2)
(the Arceus architecture) · [`Someday`](https://github.com/mavericksxx/pokemon-harness/milestone/3)
(wanted, not scheduled).

**Type** — `bug`, `enhancement`, `research` (a spike whose output is a decision, not code), `design`
(needs a design/UX decision before building), `epic`, `chore`.

**Area** — `area:garden`, `area:terminal`, `area:orchestration`, `area:ui`, `area:perf`,
`area:platform`.

**Value** — `P1` (hurts daily use) · `P2` (real value, not urgent) · `P3` (someday, ideation).
`P0` exists for "broken right now" and is currently unused. Priority is not a schedule — that's the
milestone's job.

**Effort** — `size:S` (under half a day) · `size:M` (one to two days) · `size:L` (multi-day, one
lane) · `size:XL` (needs splitting before starting). Rough by design; re-estimate at dispatch.

Every open issue carries exactly one value label and one effort label, so both axes are always
filterable. **[Issue #28](https://github.com/mavericksxx/pokemon-harness/issues/28) is pinned and
holds the ready-made "what next" queries** — start there rather than scrolling the list.

**State** — `needs-input` marks an issue blocked on a decision only the owner can make. These stall
everything downstream, so they are worth clearing first.

## the passive stuff

The old "watch items" section — observations with no action unless they recur — is
[issue #27](https://github.com/mavericksxx/pokemon-harness/issues/27), one checklist rather than
seven open issues that look like work.
