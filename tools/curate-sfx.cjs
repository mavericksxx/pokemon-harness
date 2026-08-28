#!/usr/bin/env node
'use strict';
/**
 * Curate a small subset of the attack-move SFX rip (BellBlitzKing's Gen 4
 * "Diamond, Pearl, Platinum, HG, SS Attack Move Sounds" pack, sourced from
 * sounds-resource.com -- see assets/ASSETS.md) into assets/audio/sfx/ for
 * Phase 7's battle sound effects.
 *
 * The full zip (620 per-move MP3s, ~57MB) is NOT committed to the repo --
 * only this curated subset (~1.2MB) is. Reproduce it with:
 *
 *   node tools/curate-sfx.cjs /path/to/attack-move-sfx.zip
 *
 * FILES below is the single source of truth for what's curated. Keep it in
 * sync with src/renderer/src/audio/toolSounds.ts, which maps harness tool
 * names (Read, Bash, WebFetch, ...) to these same filenames.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, existsSync, copyFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const OUT_DIR = join(__dirname, '..', 'assets', 'audio', 'sfx');

// ~18 short move SFX covering the tool->move vocabulary (toolSounds.ts) plus
// the battle victory chime (Heal_Bell) and the evolution riser (Growth).
// Preferring plain/short files over the longer originals where a `_part_1`
// split exists (none of these needed it -- all are already under 150KB).
const FILES = [
  'Peck.mp3',
  'Scratch.mp3',
  'Cut.mp3',
  'Psycho_Cut.mp3',
  'Mach_Punch.mp3',
  'Comet_Punch_1hit.mp3',
  'Pound.mp3',
  'Slam.mp3',
  'Gust.mp3',
  'Whirlwind.mp3',
  'Teleport.mp3',
  'Tackle.mp3',
  'Confusion.mp3',
  'Struggle.mp3',
  'Water_Gun.mp3',
  'Ember.mp3',
  'Heal_Bell.mp3',
  'Growth.mp3'
];

function main() {
  const zipPath = process.argv[2];
  if (!zipPath || !existsSync(zipPath)) {
    console.error('Usage: node tools/curate-sfx.cjs <path-to-attack-move-sfx.zip>');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'poke-sfx-curate-'));
  try {
    // -j junks the zip's internal folder path (long, comma-and-space-laden);
    // '*/Name.mp3' matches it by basename regardless of that folder's exact
    // name. One unzip invocation for the whole list.
    const patterns = FILES.map((f) => `*/${f}`);
    execFileSync('unzip', ['-j', '-o', zipPath, ...patterns, '-d', tmp], { stdio: 'inherit' });

    const extracted = new Set(readdirSync(tmp));
    const missing = FILES.filter((f) => !extracted.has(f));
    if (missing.length > 0) {
      console.error(`Missing from zip (names may have changed upstream): ${missing.join(', ')}`);
      process.exit(1);
    }

    let totalBytes = 0;
    for (const f of FILES) {
      const src = join(tmp, f);
      const dest = join(OUT_DIR, f);
      copyFileSync(src, dest);
      totalBytes += require('node:fs').statSync(dest).size;
    }
    console.log(`Curated ${FILES.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB, into ${OUT_DIR}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
