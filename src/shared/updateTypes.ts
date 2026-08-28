/**
 * Tier-1 update check (ship-cut item 4) — main checks GitHub's "latest
 * release" endpoint on launch and every 24h, compares semver against the
 * running app, and tells the renderer only when there's something newer.
 * See src/main/updateCheck.ts for the actual check.
 */
export interface UpdateCheckResult {
  /** True only when `latestVersion` is a strictly newer semver than
   *  `currentVersion` — a 304 Not Modified, a network failure, or a latest
   *  release that's the same or older all report `available: false`. */
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  /** The GitHub release page — window.api.openExternal target for the
   *  update toast's "download" action and the Settings row's link. */
  releaseUrl: string;
}
