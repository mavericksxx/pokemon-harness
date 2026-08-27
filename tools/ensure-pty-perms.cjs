#!/usr/bin/env node
'use strict';
/**
 * Guarantee node-pty's `spawn-helper` binaries are executable.
 *
 * Ported from munder-difflin (tools/ensure-pty-perms.cjs), MIT, Chaitanya Giri.
 *
 * On macOS/Linux node-pty execs a small `spawn-helper` binary that lives next to
 * the loaded native module. In some installs the helper shipped inside
 * `prebuilds/` lands with mode 644 (no execute bit); when that's the copy
 * node-pty loads, `pty.fork` fails with "posix_spawnp failed" on EVERY spawn.
 *
 * Best-effort: a missing node-pty or a chmod failure must never break install.
 */
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

if (process.platform === 'win32') process.exit(0);

try {
  const root = join(__dirname, '..', 'node_modules', 'node-pty');
  if (!existsSync(root)) process.exit(0);

  const candidates = [join(root, 'build', 'Release'), join(root, 'build', 'Debug')];
  for (const base of [join(root, 'prebuilds'), join(root, 'bin')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) candidates.push(join(base, entry));
  }

  let fixed = 0;
  for (const dir of candidates) {
    const helper = join(dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helper, 0o755);
    fixed++;
  }
  if (fixed > 0) console.log(`[ensure-pty-perms] restored +x on ${fixed} spawn-helper binaries`);
} catch (e) {
  console.warn('[ensure-pty-perms] skipped:', e && e.message);
}
