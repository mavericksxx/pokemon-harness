# Auto-update via GitHub Action — built, reverted, reference for next attempt

Status: **built and verified once (typecheck/build/`--dir` packaging all passed), then reverted
by request before any real release exercised it.** This is a durable reference doc, not a
temporary planning artifact — keep it until this is actually re-landed.

The working implementation is not lost: it lived on `master` as commit `27a81ca` (merged at
`4e4f2d4`) and was undone by revert commit `bdb2aa2`. `git show 4e4f2d4` (or `git diff
bdb2aa2~1 bdb2aa2`) reproduces the full diff; a future session can cherry-pick `4e4f2d4` directly
rather than rebuilding from scratch, once the gap below is fixed.

## What this was

Two things, both driven by the constraint that this app ships with **ad-hoc code signing only —
no paid Apple Developer ID, deliberately** (`build/afterSign.cjs`'s header comment):

1. A manually-triggered (`workflow_dispatch`) `.github/workflows/release.yml`: you type a tag
   (e.g. `v1.18.4`) in the Actions tab, it checks out that exact tagged commit (not just whatever
   ref the dispatch happened to run against — protects against a stale `master` HEAD shipping the
   wrong code), builds + ad-hoc-signs, and publishes the release as a **draft first**, only
   undrafting once every asset (including `latest-mac.yml`) has uploaded — avoiding a window
   where a technically-live release is missing its update-feed file.
2. In-app `electron-updater` (`src/main/autoUpdate.ts`, replacing the old `updateCheck.ts`
   browser-link-out poller): checks every 4h + on-demand, auto-downloads in the background, and a
   single "Install" button attempts `quitAndInstall()`, falling back to revealing the download in
   Finder (with copy explaining the real remaining steps: quit, unzip, drag to Applications,
   right-click → Open) when ad-hoc signing makes Squirrel.Mac refuse the silent swap — the
   **expected common case**, not a rare edge case.

`tools/release.cjs` (the pre-existing local build-and-`gh release create` script) was
**deliberately left unchanged** per explicit request, to stay available as an independent legacy
publish path alongside the new Action.

## Why it got reverted

Not a bug in what was built — a real gap discovered in the interaction between the new feature
and the *unchanged* legacy path, surfaced while testing:

**`tools/release.cjs`'s artifact filter never picks up `latest-mac.yml`.** It filters `dist/` for
files that start with `build.productName` and contain the version string and end in `.zip`,
`.zip.blockmap`, or `.dmg` (see its `artifacts` computation). `latest-mac.yml` matches none of
that — it's not prefixed with the product name and carries no version in its filename — so it's
silently never uploaded when publishing through the legacy script. Confirmed empirically: the
already-published `v1.18.3` release (cut via `tools/release.cjs --publish` before this feature
existed) has 5 assets (zip, zip.blockmap, dmg, two source archives) and **no `latest-mac.yml`**.

Net effect: a release published via the legacy script downloads and installs fine manually
(the website's link-out flow is untouched by any of this), but is **silently invisible** to
`electron-updater`'s feed — the in-app auto-update would never detect it as available, with no
error surfaced anywhere, since from electron-updater's perspective there's simply no update-feed
file to read yet. Since both publish paths were meant to be fully interchangeable release to
release, this asymmetry was judged not safe to ship as-is.

There's a second, unrelated real-world unknown this revert also punts on: whether
`quitAndInstall()` ever actually succeeds against this app's ad-hoc signing, or always falls back
to the Finder reveal. That was always going to require a real two-release test to answer (see the
original plan's Verification §7) — untouched by the revert, still open either way.

## What to fix before re-landing

1. **Close the `latest-mac.yml` gap** — the cheap fix: extend `tools/release.cjs`'s artifact glob
   to also pick up `latest-mac.yml` (and, if x64/universal targets are ever added, whatever
   architecture-specific variants electron-builder emits alongside it — check current output
   before assuming just the one file). Re-verify against a real local `npm run dist` that the file
   actually gets generated into `dist/` even without the `--publish` CLI flag (it should, since
   generation is tied to `build.publish` being configured, not to the publish flag itself — but
   this is asserted, not re-verified since the revert; check it holds before relying on it again).
   Alternatively: retire the legacy script's local-build-and-upload entirely and make the Action
   the only publish path — a simpler fix, but a scope/behavior decision for whoever picks this
   back up, not something to default into.
2. **Run the real two-release test** (cut two sequential tagged releases through whichever path
   ends up canonical, install the first, let the app find/download/offer-install the second,
   observe whether `quitAndInstall()` succeeds or falls back) to settle the one thing static
   review could never confirm, and tune the fallback UI copy/behavior based on the real answer.
3. Re-cherry-pick `4e4f2d4` (or reimplement fresh referencing it) once 1–2 are resolved, and
   re-run the same verification steps documented in the original plan (typecheck, build +
   confirm `electron-updater` actually got bundled into `out/main/index.js` rather than left as a
   bare external `require`, `--dir` packaging + direct binary launch).

## Design decisions worth preserving verbatim (still correct, don't re-derive)

- **Manual `workflow_dispatch` only**, no auto-trigger on tag push — explicit user preference,
  confirmed twice during the original conversation.
- **`tag` as a required string input**, not relying on GitHub's branch/tag ref picker — the ref
  picker only selects which version of the *workflow file* runs; `actions/checkout` still
  defaults to that ref's HEAD, not a tag, so trusting it would silently reintroduce a
  stale-HEAD-ships-wrong-code bug.
- **Draft-then-undraft release creation** — a non-draft release is live at `releases/latest` the
  instant it's created; creating it live before assets (specifically `latest-mac.yml`) are
  uploaded would give every installed app's background check a real window to hit
  `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` against a release that looks complete but isn't yet.
- **Install-with-fallback via a persistent in-flight flag, not a fixed timer** — `quitAndInstall()`
  doesn't reject on failure; a mac signature-validation failure surfaces as an `error` event on
  the `autoUpdater` singleton, and (per direct inspection of `electron-updater@6.8.9`'s
  `MacUpdater.js`) there's no fixed grace window to guess — the event fires whenever Squirrel's
  own check actually runs, not on any predictable schedule. A timer-based fallback is a real race;
  the flag-based design (`installInFlight` in `autoUpdate.ts`) reacts to the actual event instead.
- **Pre-clearing `quitConfirmed`/`setLeaveSessionsRunning` before `quitAndInstall()`, and undoing
  that pre-clear if the install actually fails** — without this, an install attempted while agent
  sessions are running hits this app's own "N agents still running" quit-confirmation dialog,
  which nothing in the auto-update flow listens for, silently stalling the install with no
  feedback; and without undoing it on failure, a failed install permanently disables that dialog
  for every later real quit.
- **Never surface the error `message` nowhere** — an earlier review round caught this: without
  showing the real electron-updater error text somewhere (even just a tooltip), the one thing this
  whole feature can't be verified without a real release (§2 above) becomes undebuggable when it
  actually happens.
