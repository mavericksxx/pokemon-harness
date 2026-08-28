'use strict';
/**
 * electron-builder `afterSign` hook — ad-hoc codesigns the packaged .app.
 *
 * STATUS (ship-cut item 3): RESOLVED. The packaged app launches cleanly on
 * this machine (macOS Darwin 25.5.0 / arm64), verified by running
 * `dist/mac-arm64/Pokeharness.app/Contents/MacOS/Pokeharness` directly and
 * confirming it stays up (no crash, no stderr).
 *
 * Investigation trail, kept because the middle of it is a real, verified
 * @electron/osx-sign quirk worth knowing about even though it wasn't the
 * root cause:
 *
 * A byte-identical, UNMODIFIED copy of the exact same downloaded Electron
 * 32.3.3 zip electron-builder uses (extracted straight from
 * ~/Library/Caches/electron/.../electron-v32.3.3-darwin-arm64.zip, never
 * touched by electron-builder or this hook) launched perfectly on this
 * machine — full process tree (GPU/network/renderer helpers), clean exit.
 * Its signature is `flags=0x20002(adhoc,linker-signed)`, the special
 * signature the Xcode/ld linker itself stamps on an arm64 binary at build
 * time and which is not achievable by resigning after the fact. Every
 * rebranded build kept crashing regardless of signing approach tried:
 *   - flat `codesign --deep --force --sign - "$APP"` (no entitlements) — traps.
 *   - flat `--deep` + `--options runtime` + entitlements — traps, AND
 *     separately broke nested-framework loading (dyld: "code signature ...
 *     different Team IDs") because `--deep` signs nested targets in
 *     whatever order `codesign` walks the bundle, not the inside-out order
 *     Apple's signing model requires — confirmed by @electron/osx-sign's
 *     own README: "`--deep` ... is not typically safe to apply to the
 *     entire Electron app."
 *   - `@electron/osx-sign` (this hook's approach — the same library
 *     electron-builder itself uses internally for a real identity) signs
 *     every nested target in the correct order and fixed the dyld error.
 *     Getting our OWN entitlements file onto each target at all took a
 *     second fix: the top-level `entitlements`/`hardenedRuntime` options
 *     are NOT what reaches each file's actual codesign call — `sign.js`
 *     merges `opts.optionsForFile?.(filePath)` over an auto-selected
 *     per-path default (main/plugin/gpu/renderer templates baked into the
 *     library); without the `optionsForFile` callback below, the MAIN
 *     executable silently came back signed with the GPU HELPER's default
 *     template instead of ours. Kept — a real, verified library quirk,
 *     independent of the actual root cause below.
 *   - Even with correct nested order and correct entitlements, every
 *     variant still trapped — with hardened runtime on, off, and with
 *     `"asar": false` to rule out asar-integrity. None of it was the
 *     trigger.
 *
 * ROOT CAUSE: the app's name. `productName` was "Pokéharness" — with a
 * precomposed é (U+00E9) — which electron-builder writes verbatim into
 * `CFBundleExecutable`/`CFBundleName` and the on-disk bundle/executable
 * filenames (`Pokéharness.app`, `Contents/MacOS/Pokéharness`, the helper
 * .app names). A non-ASCII executable/bundle name is enough to break this
 * build's AMFI trust for an ad-hoc-resigned (not linker-signed) binary,
 * independent of every signing variant above. Switching `productName` to
 * the ASCII "Pokeharness" (this file's `@electron/osx-sign` call
 * unchanged) produced a bundle that launches on the first try.
 *
 * The Pokéharness spelling isn't lost — it's not needed on disk. `mac.
 * extendInfo` in package.json sets `CFBundleDisplayName`/`CFBundleName` to
 * "Pokéharness", which is what Finder, the Dock, and the menu bar actually
 * read for display; only the on-disk bundle/executable/helper filenames are
 * ASCII "Pokeharness". `app.setName('Pokéharness')` in src/main/index.ts
 * covers in-app/menu-bar naming the same way regardless of the bundle name.
 *
 * This is still an ad-hoc signature (no paid Apple Developer ID), so
 * Gatekeeper will still show the "unidentified developer" prompt on a
 * downloaded release — see the README's unsigned-build note for the
 * right-click-Open workaround. That's expected and separate from the
 * crash this hook used to produce.
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
