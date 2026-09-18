#!/usr/bin/env node
'use strict';
/**
 * Force @electron/rebuild to actually recompile node-pty from (our patched)
 * source, instead of silently reusing a stale prebuilt binary.
 *
 * Root cause (found while wiring up patches/node-pty+1.1.0.patch — the
 * quit-hang fix, see that patch's own header): @electron/rebuild's
 * ModuleRebuilder.alreadyBuiltByRebuild() (node_modules/app-builder-lib/
 * node_modules/@electron/rebuild/lib/module-rebuilder.js) treats a
 * `build/<Release|Debug>/.forge-meta` file whose contents already match the
 * current `<arch>--<ABI>` as proof the module is already built for this
 * target, and skips node-gyp entirely — verified empirically: on a checkout
 * with a pre-existing `build/Release/pty.node` + matching `.forge-meta`,
 * `electron-builder install-app-deps` logged
 * `preparing moduleName=node-pty` / `finished moduleName=node-pty` and exited
 * successfully WITHOUT touching pty.node's mtime or content at all, even
 * after src/unix/pty.cc had just been patched. Electron-builder's own
 * `install-app-deps` never sets @electron/rebuild's `force` option, so
 * nothing else clears this. A patch to node-pty's source is silently dead —
 * still applied on disk, never actually compiled in — on any machine that
 * already has a node-pty build from before the patch existed (which, absent
 * this script, includes every dev machine and every CI cache that installed
 * dependencies before patches/node-pty+1.1.0.patch was added).
 *
 * Deletes only the `.forge-meta` marker(s), not the whole `build/` tree —
 * node-gyp's own Makefile already has correct per-file dependency tracking
 * (pty.o depends on pty.cc's mtime), so an incremental `node-gyp rebuild`
 * still recompiles exactly what changed; this just removes the one file
 * that lets @electron/rebuild skip invoking node-gyp at all. Best-effort,
 * same as ensure-pty-perms.cjs alongside it: a missing node-pty or an
 * unremovable file must never break install.
 */
const { existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

try {
  const buildDir = join(__dirname, '..', 'node_modules', 'node-pty', 'build');
  let removed = 0;
  for (const buildType of ['Release', 'Debug']) {
    const metaPath = join(buildDir, buildType, '.forge-meta');
    if (!existsSync(metaPath)) continue;
    rmSync(metaPath);
    removed++;
  }
  if (removed > 0) console.log(`[force-node-pty-rebuild] cleared ${removed} stale .forge-meta marker(s)`);
} catch (e) {
  console.warn('[force-node-pty-rebuild] skipped:', e && e.message);
}
