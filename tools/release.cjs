#!/usr/bin/env node
'use strict';
/**
 * Ship-cut item 4a — tier-1 release script. Bumps the version, builds the
 * mac artifact (npm run dist), and PRINTS (never runs, unless --publish is
 * explicitly passed) the `gh release create` command to actually publish it.
 *
 * This is deliberately conservative: a real GitHub release is a one-way,
 * user-facing action (it's what the in-app update checker — updateCheck.ts —
 * starts pointing everyone at), so this script never does it on its own
 * say-so. Default behavior does all the LOCAL work (version bump, commit,
 * tag, build) and stops at the door.
 *
 * Usage:
 *   node tools/release.cjs [patch|minor|major|<x.y.z>]   # default: patch
 *   node tools/release.cjs [patch|minor|major|<x.y.z>] --publish
 *
 * Without --publish: bumps + commits + tags locally, builds, prints the
 * exact `git push` + `gh release create` commands to run when ready.
 * With --publish: also runs those commands for you (still requires `gh` to
 * be authenticated — this script never handles credentials itself).
 *
 * Special case: if the requested version already equals package.json's
 * current version (e.g. cutting v1.0.0 itself, right after hand-setting
 * "version": "1.0.0" with no prior tag) there's nothing to bump — `npm
 * version` would error ("Version not changed"). This script detects that
 * and just tags the current HEAD instead of bumping, then proceeds to build
 * as usual. Every other invocation (patch/minor/major, or an explicit
 * version that differs from the current one) goes through `npm version`.
 *
 * Requires a clean git working tree (uncommitted changes would otherwise
 * get swept into the version-bump commit) and the `gh` CLI on PATH.
 */
const { execSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const REPO_ROOT = join(__dirname, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const PKG = require(join(REPO_ROOT, 'package.json'));

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
}

function runLoud(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function fail(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const bumpArg = args.find((a) => a !== '--publish') || 'patch';

if (!['patch', 'minor', 'major'].includes(bumpArg) && !/^\d+\.\d+\.\d+$/.test(bumpArg)) {
  fail(`bad version argument "${bumpArg}" — expected patch, minor, major, or an explicit x.y.z`);
}

// ---- preconditions ----
try {
  run('which gh');
} catch {
  fail('`gh` CLI not found on PATH — install it (or run without --publish and use the printed command later).');
}

const gitStatus = run('git status --porcelain');
if (gitStatus) {
  fail('working tree is not clean — commit or stash your changes before releasing.');
}

const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'master' && branch !== 'main') {
  console.warn(`[release] warning: releasing from branch "${branch}", not master/main.`);
}

// ---- version bump (npm handles package.json + package-lock.json + the
// git commit + the vX.Y.Z tag together — no reason to hand-roll any of
// that) ----
// Explicit x.y.z matching the CURRENT version (e.g. cutting the very first
// release right after hand-setting "version": "1.0.0") is a no-op, not an
// error — `npm version` itself would fail ("Version not changed") since it
// only knows how to bump. Skip straight to build/artifact/tag-check in that
// one case; every other path (patch/minor/major, or an explicit version
// that's actually different) still goes through `npm version` as before.
let version = PKG.version;
if (bumpArg === version) {
  console.log(`[release] requested version v${version} matches package.json already — skipping bump.`);
  const existingTag = (() => {
    try {
      return run(`git rev-parse -q --verify refs/tags/v${version}`);
    } catch {
      return '';
    }
  })();
  if (!existingTag) {
    console.log(`[release] tagging current HEAD as v${version} (no version-bump commit needed).`);
    run(`git tag -a v${version} -m "Release v${version}"`);
  } else {
    console.log(`[release] tag v${version} already exists — reusing it.`);
  }
} else {
  console.log(`[release] bumping version (${bumpArg})…`);
  const newVersionOut = run(`npm version ${bumpArg} -m "Release v%s"`);
  version = newVersionOut.replace(/^v/, '');
  console.log(`[release] now at v${version}`);
}

// ---- build ----
console.log('[release] building (npm run dist)…');
runLoud('npm run dist');

// ---- locate artifacts ----
// Only accept filenames starting with the exact ASCII build.productName —
// dist/ can accumulate STALE artifacts from earlier builds (e.g. a leftover
// é-named zip from before productName was switched to ASCII for AMFI
// signing — see build/afterSign.cjs), and a naive glob-by-version would
// happily ship one of those instead of the real, current build.
if (!existsSync(DIST_DIR)) fail(`expected build output at ${DIST_DIR} — dist step did not produce it.`);
const artifacts = readdirSync(DIST_DIR)
  .filter((f) => f.startsWith(PKG.build.productName) && f.includes(version) && (f.endsWith('.zip') || f.endsWith('.zip.blockmap') || f.endsWith('.dmg')))
  .map((f) => join('dist', f));

if (artifacts.length === 0) {
  fail(`no v${version} artifacts found in dist/ — check the build output above.`);
}
console.log('[release] artifacts:');
for (const a of artifacts) console.log(`  ${a}`);

// ---- the gh command ----
const tag = `v${version}`;
const ghCmd = [
  'gh release create',
  tag,
  ...artifacts.map((a) => `"${a}"`),
  `--title "Pokéharness ${tag}"`,
  '--generate-notes'
].join(' ');

console.log('');
console.log('[release] local work done: version bumped, committed, tagged.');
console.log('[release] to publish, push the branch + tag, then create the release:');
console.log('');
console.log(`  git push && git push origin ${tag}`);
console.log(`  ${ghCmd}`);
console.log('');

if (publish) {
  console.log('[release] --publish passed — running the above now.');
  runLoud(`git push && git push origin ${tag}`);
  runLoud(ghCmd);
  console.log(`[release] published ${tag}.`);
} else {
  console.log('[release] --publish not passed — nothing pushed or published. Run the commands above when ready.');
}
