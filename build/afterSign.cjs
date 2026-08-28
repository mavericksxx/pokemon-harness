'use strict';
/**
 * electron-builder `afterSign` hook — ad-hoc codesigns the packaged .app.
 *
 * STATUS (ship-cut item 3): this hook produces the most standards-correct
 * ad-hoc signature this investigation found, but the packaged app still
 * does NOT launch on this machine (macOS Darwin 25.5.0 / arm64) — every
 * variant traps instantly with EXC_BREAKPOINT/SIGTRAP, no stderr, no
 * crash-report detail beyond a mis-symbolicated backtrace pinned inside V8
 * frames (every frame resolves to the same symbol at impossible
 * multi-megabyte offsets — that's a mis-symbolicated abort, not a real V8
 * JIT stack; don't read "JIT" as the diagnosis). Root cause, narrowed as
 * far as this session got:
 *
 * A byte-identical, UNMODIFIED copy of the exact same downloaded Electron
 * 32.3.3 zip electron-builder uses (extracted straight from
 * ~/Library/Caches/electron/.../electron-v32.3.3-darwin-arm64.zip, never
 * touched by electron-builder or this hook) launches perfectly on this same
 * machine — full process tree (GPU/network/renderer helpers), clean exit.
 * Its signature is `flags=0x20002(adhoc,linker-signed)` — the special
 * signature the Xcode/ld linker itself stamps on an arm64 binary at build
 * time, which is not achievable by resigning after the fact. The instant
 * electron-builder rebrands that binary (patches "Electron" ->
 * "Pokéharness" into Info.plist and the executable's own embedded
 * resources, per its productName), the "linker-signed" signature is
 * invalidated by the byte changes, and the rebranded binary needs to be
 * resigned some other way to run at all on Apple Silicon. Every resigning
 * approach this session tried lands on a plain `adhoc` (not
 * `linker-signed`) signature, and this specific macOS build's AMFI policy
 * traps a plain-ad-hoc-signed process instantly regardless of what
 * entitlements it carries:
 *   - flat `codesign --deep --force --sign - "$APP"` (no entitlements) — traps.
 *   - flat `--deep` + `--options runtime` + this file's entitlements — traps,
 *     AND separately broke nested-framework loading entirely (dyld: "code
 *     signature ... different Team IDs") because `--deep` signs nested
 *     targets in whatever order `codesign` walks the bundle, not the
 *     inside-out order Apple's signing model requires — confirmed by
 *     @electron/osx-sign's own README: "`--deep` ... is not typically safe
 *     to apply to the entire Electron app."
 *   - `@electron/osx-sign` (this hook's current approach — the same library
 *     electron-builder itself uses internally for a real identity) signs
 *     every nested target in the correct order and fixed the dyld error.
 *     Getting our OWN entitlements file onto each target at all took a
 *     second fix: the top-level `entitlements`/`hardenedRuntime` options
 *     are NOT what reaches each file's actual codesign call —
 *     `sign.js` merges `opts.optionsForFile?.(filePath)` over an
 *     auto-selected per-path default (main/plugin/gpu/renderer templates
 *     baked into the library); without the `optionsForFile` callback below,
 *     the MAIN executable silently came back signed with the GPU HELPER's
 *     default template instead of ours. Fixed, and worth keeping regardless
 *     of the outcome below — it's a real, verified library quirk.
 *   - Even with correct nested order AND our own
 *     allow-jit/allow-unsigned-executable-memory/disable-library-validation
 *     entitlements correctly embedded (verified with `codesign -d
 *     --entitlements -`) under hardened runtime: still traps.
 *   - Same signing, hardened runtime OFF (current setting below — no
 *     restriction to need an entitlement bypass for at all): still traps.
 *   - `"asar": false` (rules out asar/asar-integrity as the trigger
 *     entirely): still traps.
 *
 * That exhausted this session's ideas for getting a modified/rebranded
 * arm64 Electron binary trusted enough to run without a real signature.
 * The straightforward next step is a paid Apple Developer ID: swap
 * `mac.identity: null` for a real identity (or a CSC_LINK/CSC_KEY_PASSWORD
 * env pair) and delete this whole hook — electron-builder's built-in
 * signing does the right thing once there's a real certificate behind it,
 * and a properly-signed binary keeps its "linker-signed"-equivalent trust
 * even after rebranding. Until then, `npm run dist` produces a bundle that
 * builds cleanly but is not currently launchable on this machine.
 */
const { join } = require('node:path');
const { signAsync } = require('@electron/osx-sign');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  const entitlements = join(__dirname, 'entitlements.mac.plist');

  console.log(`[afterSign] ad-hoc signing ${appPath} (@electron/osx-sign, correct nested order)`);
  await signAsync({
    app: appPath,
    identity: '-', // ad hoc — no paid Developer ID on this machine
    identityValidation: false, // '-' isn't a real keychain identity to look up
    // optionsForFile, not top-level entitlements/hardenedRuntime — see the
    // header comment for why the top-level keys don't reach per-file signing.
    // hardenedRuntime: false — with it on, correctly-applied entitlements
    // still didn't get the app past the launch trap (see header); off is at
    // least not adding an unhonored restriction on top of the real problem.
    optionsForFile: () => ({ entitlements, hardenedRuntime: false })
  });
};
