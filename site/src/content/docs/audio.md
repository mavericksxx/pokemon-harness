---
title: Audio
order: 6
---

A speaker icon in the top bar opens a compact popover: a master mute, a
Music toggle + volume slider, and an SFX toggle + volume slider. All five
settings persist across relaunch (`app.getPath('userData')/audio-settings.json`).
**Music is OFF by default** on first run (so it doesn't start playing
unannounced); **SFX is ON by default**.

Music tracks are HeartGold/SoulSilver OST clips, fetched from khinsider the
first time you turn Music on (never bundled — see `assets/ASSETS.md` for the
two-hop fetch this needs) and cached to disk after that. The popover shows
"downloading music… (n/9)" while that first fetch is in flight; if it's
offline, Music shows "unavailable offline" and switches itself back off
rather than silently doing nothing. Once ready: an ambient track plays on a
shuffled, no-immediate-repeat rotation with a ~2.5s crossfade between songs;
any battle crossfades to a battle track for as long as at least one battle is
active (overlapping battles share one track); an evolution ceremony
crossfades to a charge loop for the oscillation phases and a short fanfare at
the flash/reveal, then hands the bus back to whichever of battle/ambient was
playing underneath — never unconditionally back to ambient, so a ceremony
mid-battle doesn't cut that battle's music.

SFX (independent of the Music toggle) covers: a species' cry on its walker's
first spawn and again at an evolution's reveal (also fetched-and-cached, from
Pokemon Showdown); a per-tool "move" sound on each battle attack (Read/Grep
scratch/peck, Edit/Write a Cut, Bash a punch, WebFetch/WebSearch a
Gust/Whirlwind, Task a Teleport, anything else a generic hit — see
`src/renderer/src/audio/toolSounds.ts`); a victory chime; and a soft riser at
evolution ceremony start. These clips are a small curated, committed subset
(not fetched) — see `assets/ASSETS.md`.
