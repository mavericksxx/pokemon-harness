---
title: Pokemon picker
order: 5
---

The "Pokemon" field in the New Session dialog is a type-ahead search over the
full #1-1025 dex by name or dex number (empty search shows the 42 bundled
species, which need no network). Uniqueness is per evolution **line**: picking
any stage of a line that's already out in the garden is greyed out. Picking a
non-base stage shows an inline note ("Gengar joins as Gastly — it'll evolve as
your agent works (Gastly → Haunter → Gengar)"); base-stage picks show the same
chain without the caveat. Un-truncated chains cross the old Gen-5 cutoff
too — e.g. searching Kingambit shows "Kingambit joins as Pawniard".

Gen 6-9 (#650-1025) results carry a small "static sprite" tag, since those
species use a still image rather than the Gen 1-5 lines' idle animation (see
`assets/ASSETS.md`). A species the Smogon Sprite Project has no art for shows
greyed out with a "no sprite available" tooltip instead of a pickable option —
`tools/build-dex.cjs` records that per-species as `hasSprite: false` from a
build-time coverage sweep, so a bad pick can't fail after the fact.

Species outside the bundled 42 are fetched on demand from Pokemon Showdown (or,
for statics, the Smogon Sprite Project via the same Showdown-hosted mirror) at
runtime and cached to disk under `app.getPath('userData')/sprites/`, so each
species is fetched at most once ever, from any machine running the app. A
fetch failure (offline, 404) falls back to a pokeball placeholder plus a
dismissible toast, and retries on the next pick rather than remembering the
failure.
