// Pokéharness macOS 26 (Tahoe) dock icon — Icon Composer asset generator.
//
// Context: the shipped build/icon.icns is genuinely full-bleed (verified —
// every corner pixel opaque at 1024px), yet Tahoe's Dock still draws the
// app scaled down on the system's light squircle "plate". That's Tahoe's
// documented treatment of apps that ship ONLY a legacy .icns: without a
// compiled Icon Composer asset (Assets.car + CFBundleIconName in
// Info.plist), the OS falls back to plating the icon onto its own squircle
// instead of letting the app's own edge-to-edge art fill it. See BACKLOG.md
// ("dock icon white ring RETURNED on macOS Tahoe").
//
// This script builds a minimal, single-layer Icon Composer (.icon) document
// — our existing full-bleed artwork as the one layer, no glass/specular
// effects — from build/icon/icon-1024.png (written by gen-icon.mjs; run
// that first if it's missing), then compiles it with `actool` into
// build/Assets.car. The .icns stays wired as-is for pre-Tahoe macOS
// (package.json's mac.icon); this script only adds the Tahoe-side asset.
//
// The .icon document format (icon.json + an Assets/ subfolder of layer
// images) is Icon Composer's, normally hand-edited via the Icon Composer.app
// GUI shipped with Xcode 26+. There's no public schema doc; this script's
// icon.json was derived from a real, working single/multi-layer example
// (jimeh/emacs-liquid-glass-icons, MIT) and pared down to one flat layer —
// verified by actually compiling it with actool on this machine (Xcode
// 26.6) and inspecting the resulting Assets.car with `assetutil --info`
// (multiple Icon Image entries at 1x/2x scales, AssetType "Icon Image",
// named after --app-icon below).
//
// Requires on PATH (or via `xcrun`): `actool`, part of Xcode's command-line
// tools (Xcode 26+ for Tahoe icon support) — NOT a runtime dependency, only
// needed to regenerate build/Assets.car. Regeneration is occasional (only
// when the source art changes); the compiled Assets.car is checked into
// the repo so ordinary builds/CI don't need actool at all. If actool is
// missing when you DO need to regenerate, this script fails loudly rather
// than silently skipping — the checked-in Assets.car is left untouched, so
// existing builds keep working (with a stale but valid Tahoe asset) either
// way, and the .icns fallback always keeps pre-Tahoe macOS working
// regardless of any of this.
//
// Run: node build/icon/gen-tahoe-icon.mjs
// Writes build/Assets.car (checked in; wired into Contents/Resources via
// package.json's mac.extraResources, alongside mac.extendInfo's
// CFBundleIconName — see package.json's "build" section).

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SOURCE_PNG = join(HERE, 'icon-1024.png');
const TMP = join(HERE, '_tmp_tahoe');
const COMPILE_OUT = join(TMP, 'out');
const ASSETS_CAR_OUT = join(REPO_ROOT, 'build', 'Assets.car');

// The app icon name compiled into Assets.car. Must match package.json's
// mac.extendInfo.CFBundleIconName exactly — that key is how Tahoe looks up
// this icon set inside Assets.car at runtime.
const APP_ICON = 'PokeharnessIcon';
const ICON_DOC = join(TMP, `${APP_ICON}.icon`);

function sh(cmd) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
}

function main() {
  if (!existsSync(SOURCE_PNG)) {
    throw new Error(
      `missing ${SOURCE_PNG} — run "node build/icon/gen-icon.mjs" first to render the 1024px master.`
    );
  }

  try {
    sh('xcrun --find actool');
  } catch {
    console.error(
      '[gen-tahoe-icon] actool not found (needs Xcode 26+ command-line tools). ' +
        'Cannot regenerate build/Assets.car — the existing checked-in copy (if any) is left untouched, ' +
        'and the .icns fallback keeps the app icon working on all macOS versions regardless.'
    );
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(ICON_DOC, 'Assets'), { recursive: true });
  mkdirSync(COMPILE_OUT, { recursive: true });

  cpSync(SOURCE_PNG, join(ICON_DOC, 'Assets', 'icon-1024.png'));

  // Single flat layer, our existing full-bleed art, no glass/specular/
  // shadow effects — "supported-platforms.squares: shared" means one
  // rendering shared across light/dark/tinted appearances (we don't ship
  // per-appearance art). No "circles" entry — we don't target watchOS.
  const iconJson = {
    groups: [
      {
        layers: [
          {
            'image-name': 'icon-1024.png',
            name: 'artwork'
          }
        ],
        name: 'Group'
      }
    ],
    'supported-platforms': {
      squares: 'shared'
    }
  };
  writeFileSync(join(ICON_DOC, 'icon.json'), JSON.stringify(iconJson, null, 2));

  console.log(`[gen-tahoe-icon] compiling ${ICON_DOC} with actool…`);
  const partialPlist = join(COMPILE_OUT, 'partial-info.plist');
  const output = sh(
    [
      'xcrun actool',
      `"${ICON_DOC}"`,
      '--warnings --errors --notices',
      '--output-format human-readable-text',
      `--compile "${COMPILE_OUT}"`,
      `--app-icon ${APP_ICON}`,
      '--include-all-app-icons',
      '--enable-on-demand-resources NO',
      '--enable-icon-stack-fallback-generation NO',
      '--development-region en',
      '--target-device mac',
      '--platform macosx',
      '--minimum-deployment-target 26.0',
      `--output-partial-info-plist "${partialPlist}"`
    ].join(' ')
  );
  console.log(output);

  const carPath = join(COMPILE_OUT, 'Assets.car');
  if (!existsSync(carPath)) {
    throw new Error(`actool did not produce Assets.car at ${carPath} — see its output above.`);
  }

  mkdirSync(dirname(ASSETS_CAR_OUT), { recursive: true });
  cpSync(carPath, ASSETS_CAR_OUT);
  console.log(`[gen-tahoe-icon] wrote ${ASSETS_CAR_OUT}`);
  console.log(
    `[gen-tahoe-icon] app icon name compiled into Assets.car: "${APP_ICON}" — ` +
      'must match package.json build.mac.extendInfo.CFBundleIconName.'
  );

  rmSync(TMP, { recursive: true, force: true });
}

main();
