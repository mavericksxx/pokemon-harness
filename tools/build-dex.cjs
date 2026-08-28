#!/usr/bin/env node
'use strict';
/**
 * Generate `assets/dex/dexIndex.json` and `assets/dex/lines.json` — the full
 * Gen 1-9 dex (#1-1025) the picker searches (Phase 6 §1).
 *
 * Source of truth is Pokemon Showdown's own `data/pokedex.json`, fetched live
 * rather than hand-copied, so evolution chains stay correct as Showdown's data
 * updates (e.g. Primeape -> Annihilape, Eevee -> Sylveon) without this script
 * needing per-species overrides.
 *
 * Species #1-649 use Showdown's animated Gen-5 sprites (`sprites/gen5ani/`,
 * matching the walker art in `showdownArt.ts`/`lazySprites.ts`). Species
 * #650-1025 (Gen 6-9) have no such animation — Showdown only ever drew Gen-5
 * pixel art through Gen 5 — so they use the Smogon Sprite Project's fan-made
 * Gen-5-STYLE STATIC sprites instead (`sprites/gen5/`), marked `static: true`.
 * This script HEAD/GET-checks every one of those against the live site and
 * records `hasSprite: false` for confirmed 404s (Phase 6 §2) — the Smogon
 * project's coverage of very recent species is not 100%, and the picker uses
 * this flag to grey those out rather than let them fail at pick time.
 *
 * Run with `npm run gen:dex`.
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_DIR = join(__dirname, '..', 'assets', 'dex');
const POKEDEX_URL = 'https://play.pokemonshowdown.com/data/pokedex.json';
const SPRITE_CHECK_BASE = 'https://play.pokemonshowdown.com/sprites/gen5';

/** #650 and up get the Smogon static sprites instead of animated gen5ani. */
const STATIC_THRESHOLD = 649;
const MAX_NUM = 1025;

/** Name-pattern edge cases worth calling out separately in the report: if
 *  these fail at a much higher rate than the overall sweep, the likely cause
 *  is this script deriving the wrong sprite filename (id != Showdown's own
 *  id), not the Smogon project actually lacking the art. */
const EDGE_CASE_IDS = [
  'typenull', 'jangmoo', 'hakamoo', 'kommoo', 'tapukoko', 'tapulele', 'tapubulu', 'tapufini',
  'mrrime', 'sirfetchd', 'greattusk', 'screamtail', 'brutebonnet', 'fluttermane', 'slitherwing',
  'sandyshocks', 'roaringmoon', 'ironvaliant', 'irontreads', 'ironbundle', 'ironhands',
  'ironjugulis', 'ironmoth', 'ironthorns', 'wochien', 'chienpao', 'tinglu', 'chiyu',
  'walkingwake', 'gougingfire', 'ragingbolt', 'ironboulder', 'ironcrown', 'terapagos',
  'ogerpon', 'okidogi', 'munkidori', 'fezandipiti'
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** True if any of a species' ability slots (0/1/H/S — hidden/event slots
 *  included, matched case-insensitively) is Levitate. */
function hasLevitate(abilities) {
  return Object.values(abilities || {}).some(
    (a) => typeof a === 'string' && a.toLowerCase() === 'levitate'
  );
}

/** Levitate ability -> levitate, Flying type -> fly, else walk. Checked in
 *  that order so a species with both (none currently) reads as levitate. */
function deriveLocomotion(entry) {
  if (hasLevitate(entry.abilities)) return 'levitate';
  if (Array.isArray(entry.types) && entry.types.includes('Flying')) return 'fly';
  return 'walk';
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `sprites/gen5/<id>.png` exists. A definitive 404 (from HEAD, or a
 *  GET fallback if HEAD comes back anything other than 200/404) is the only
 *  way this returns a confirmed miss; anything else (timeout, 429, 5xx) is
 *  treated as "can't tell" and counted as a hit, so a flaky sweep never bakes
 *  a false negative into committed data. Returns whether the sprite was
 *  confirmed present, plus whether the result was indeterminate. */
async function probeSprite(id) {
  const url = `${SPRITE_CHECK_BASE}/${id}.png`;
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' }, 10000);
    if (head.status === 404) return { present: false, indeterminate: false };
    if (head.ok) return { present: true, indeterminate: false };
    const get = await fetchWithTimeout(url, { method: 'GET' }, 10000);
    if (get.status === 404) return { present: false, indeterminate: false };
    return { present: true, indeterminate: !get.ok };
  } catch {
    return { present: true, indeterminate: true };
  }
}

/** Sweeps every static-tier id with bounded concurrency, gentle on Showdown's
 *  static host (no auth, no rate-limit documented, but ~370 ids doesn't need
 *  more than a handful in flight at once). */
async function sweepSpriteCoverage(ids) {
  const CONCURRENCY = 8;
  const present = new Map();
  let indeterminateCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const result = await probeSprite(id);
      present.set(id, result.present);
      if (result.indeterminate) indeterminateCount++;
    }
  }

  console.log(`Checking sprite coverage for ${ids.length} static (#>${STATIC_THRESHOLD}) species...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { present, indeterminateCount };
}

function buildCandidates(pokedex) {
  const candidates = new Map();
  for (const [id, entry] of Object.entries(pokedex)) {
    // Alt/regional/mega/gmax formes carry a `forme` field; skip them so each
    // dex number maps to exactly one base-forme entry.
    if (entry.forme) continue;
    if (typeof entry.num !== 'number' || entry.num < 1 || entry.num > MAX_NUM) continue;
    candidates.set(id, entry);
  }

  const byNum = new Map();
  for (const [id, entry] of candidates) {
    const list = byNum.get(entry.num) ?? [];
    list.push(id);
    byNum.set(entry.num, list);
  }
  const dupes = [...byNum.entries()].filter(([, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    throw new Error(
      `build-dex: Showdown's pokedex.json has more than one base-forme candidate for dex #${dupes
        .map(([n, ids]) => `${n} (${ids.join(', ')})`)
        .join('; #')} — this script's forme filter needs a look`
    );
  }
  const missing = [];
  for (let n = 1; n <= MAX_NUM; n++) if (!byNum.has(n)) missing.push(n);
  if (missing.length > 0) {
    throw new Error(`build-dex: no base-forme candidate for dex #${missing.join(', #')}`);
  }

  return candidates;
}

/** Resolve a `prevo` display name to a candidate id, or null when it doesn't
 *  resolve to one — which happens legitimately for species whose real prevo
 *  is a regional forme this dex doesn't carry (Sirfetch'd's prevo is
 *  "Farfetch'd-Galar", not national Farfetch'd; Mr. Rime's is "Mr.
 *  Mime-Galar"). Those become roots of their own single-member line, which is
 *  correct: the national-dex base form doesn't evolve into them in-game. */
function resolvePrevo(entry, nameToId, candidates) {
  if (!entry.prevo) return null;
  const id = nameToId.get(entry.prevo);
  return id && candidates.has(id) ? id : null;
}

function buildLineage(candidates, nameToId) {
  const prevoOf = new Map();
  const childrenOf = new Map();
  for (const [id, entry] of candidates) {
    const parent = resolvePrevo(entry, nameToId, candidates);
    prevoOf.set(id, parent);
    if (parent) {
      const list = childrenOf.get(parent) ?? [];
      list.push(id);
      childrenOf.set(parent, list);
    }
  }

  const lineOf = new Map();
  const stageOf = new Map();
  const roots = [...candidates.keys()].filter((id) => prevoOf.get(id) === null);
  for (const root of roots) {
    lineOf.set(root, root);
    stageOf.set(root, 1);
    const queue = [root];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const child of childrenOf.get(cur) ?? []) {
        lineOf.set(child, root);
        stageOf.set(child, stageOf.get(cur) + 1);
        queue.push(child);
      }
    }
  }

  const orphans = [...candidates.keys()].filter((id) => !lineOf.has(id));
  if (orphans.length > 0) {
    // Can only happen if a prevo chain cycles back on itself before reaching
    // a root — Showdown's data shouldn't do this, but a silent infinite-depth
    // species is worse than a loud build failure.
    throw new Error(`build-dex: ${orphans.length} species unreachable from any line root (possible prevo cycle): ${orphans.join(', ')}`);
  }

  return { childrenOf, lineOf, stageOf };
}

function validate(dexIndex, lines) {
  const errors = [];
  const ids = new Set(Object.keys(dexIndex));

  for (const entry of Object.values(dexIndex)) {
    for (const target of entry.evolvesTo) {
      if (!ids.has(target)) {
        errors.push(`${entry.id}: evolvesTo target "${target}" does not exist in dexIndex`);
        continue;
      }
      const targetEntry = dexIndex[target];
      if (targetEntry.line !== entry.line) {
        errors.push(`${entry.id} -> ${target}: line mismatch ("${entry.line}" vs "${targetEntry.line}")`);
      }
      if (targetEntry.stage !== entry.stage + 1) {
        errors.push(`${entry.id} -> ${target}: expected stage ${entry.stage + 1}, got ${targetEntry.stage}`);
      }
    }
  }

  for (const line of lines) {
    const root = dexIndex[line.line];
    if (!root) {
      errors.push(`line "${line.line}": root id not in dexIndex`);
      continue;
    }
    if (root.stage !== 1) errors.push(`line "${line.line}": root's stage is ${root.stage}, expected 1`);
    for (const memberId of line.members) {
      if (dexIndex[memberId]?.line !== line.line) {
        errors.push(`line "${line.line}": member "${memberId}" claims a different line ("${dexIndex[memberId]?.line}")`);
      }
    }
  }

  // No id claimed by two lines, and no cycles: every non-root's stage is
  // strictly greater than 1 (a cycle would mean a member pointed back to
  // stage <= its own, which the line-membership check above already forbids
  // structurally since lines are built by one BFS pass per root).
  const idToLine = new Map();
  for (const line of lines) {
    for (const memberId of line.members) {
      if (idToLine.has(memberId)) {
        errors.push(`"${memberId}" appears in two lines: "${idToLine.get(memberId)}" and "${line.line}"`);
      }
      idToLine.set(memberId, line.line);
    }
  }
  for (const id of ids) {
    if (!idToLine.has(id)) errors.push(`"${id}" is in dexIndex but not in any line's members`);
  }

  if (errors.length > 0) {
    throw new Error(`build-dex: ${errors.length} validation error(s):\n  ${errors.slice(0, 50).join('\n  ')}`);
  }
}

async function main() {
  console.log(`Fetching ${POKEDEX_URL} ...`);
  const pokedex = await fetchJson(POKEDEX_URL);

  const nameToId = new Map();
  for (const [id, entry] of Object.entries(pokedex)) nameToId.set(entry.name, id);

  const candidates = buildCandidates(pokedex);
  console.log(`${candidates.size} base-forme species, dex #1-${MAX_NUM}.`);

  const { childrenOf, lineOf, stageOf } = buildLineage(candidates, nameToId);

  const staticIds = [...candidates.keys()].filter((id) => candidates.get(id).num > STATIC_THRESHOLD);
  const { present, indeterminateCount } = await sweepSpriteCoverage(staticIds);

  const dexIndex = {};
  for (const [id, entry] of candidates) {
    const evolvesTo = (childrenOf.get(id) ?? [])
      .slice()
      .sort((a, b) => candidates.get(a).num - candidates.get(b).num);
    const isStatic = entry.num > STATIC_THRESHOLD;
    dexIndex[id] = {
      id,
      name: entry.name,
      num: entry.num,
      line: lineOf.get(id),
      stage: stageOf.get(id),
      evolvesTo,
      locomotion: deriveLocomotion(entry),
      hasSprite: isStatic ? present.get(id) !== false : true,
      ...(isStatic ? { static: true } : {})
    };
  }
  // Dex-number order, matching how the file has always read.
  const orderedDexIndex = Object.fromEntries(
    Object.values(dexIndex)
      .sort((a, b) => a.num - b.num)
      .map((e) => [e.id, e])
  );

  const lineIds = [...new Set(Object.values(dexIndex).map((e) => e.line))].sort(
    (a, b) => dexIndex[a].num - dexIndex[b].num
  );
  const lines = lineIds.map((lineId) => ({
    line: lineId,
    members: Object.values(dexIndex)
      .filter((e) => e.line === lineId)
      .sort((a, b) => a.stage - b.stage || a.num - b.num)
      .map((e) => e.id),
    displayName: dexIndex[lineId].name
  }));

  validate(orderedDexIndex, lines);

  writeFileSync(join(OUT_DIR, 'dexIndex.json'), JSON.stringify(orderedDexIndex, null, 2) + '\n');
  writeFileSync(join(OUT_DIR, 'lines.json'), JSON.stringify(lines, null, 2) + '\n');

  const staticCount = staticIds.length;
  const hitCount = staticIds.filter((id) => present.get(id) !== false).length;
  const missing = staticIds.filter((id) => present.get(id) === false);
  const edgeCaseChecked = EDGE_CASE_IDS.filter((id) => staticIds.includes(id));
  const edgeCaseMisses = edgeCaseChecked.filter((id) => present.get(id) === false);

  console.log('');
  console.log(`Wrote ${Object.keys(orderedDexIndex).length} species to assets/dex/dexIndex.json`);
  console.log(`Wrote ${lines.length} lines to assets/dex/lines.json`);
  console.log('');
  console.log(`Sprite coverage (sprites/gen5/<id>.png, dex #${STATIC_THRESHOLD + 1}-${MAX_NUM}):`);
  console.log(`  ${hitCount}/${staticCount} confirmed present (${((hitCount / staticCount) * 100).toFixed(1)}%)`);
  console.log(`  ${indeterminateCount} indeterminate result(s) during the sweep (counted as present)`);
  console.log(`  Edge-case name patterns checked: ${edgeCaseChecked.length}, missed: ${edgeCaseMisses.length}`);
  if (missing.length > 0) {
    console.log(`  Confirmed missing (hasSprite: false): ${missing.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
