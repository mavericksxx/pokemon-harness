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
const SPRITE_ANI_BASE = 'https://play.pokemonshowdown.com/sprites/gen5ani';

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

/** Whether `<baseUrl>/<id>.<ext>` exists. A definitive 404 (from HEAD, or a
 *  GET fallback if HEAD comes back anything other than 200/404) is the only
 *  way this returns a confirmed miss; anything else (timeout, 429, 5xx) is
 *  treated as "can't tell" and counted as a hit, so a flaky sweep never bakes
 *  a false negative into committed data. Returns whether the sprite was
 *  confirmed present, plus whether the result was indeterminate.
 *
 *  Parameterized by base URL + extension so the same HEAD/GET/404 logic
 *  covers both the static gen5 PNG tier (base dex, #650+) and the animated
 *  gen5ani GIF / static gen5 PNG tiers used for alt-form probing below. */
async function probeSprite(id, baseUrl = SPRITE_CHECK_BASE, ext = 'png') {
  const url = `${baseUrl}/${id}.${ext}`;
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

/** Runs `handler(item)` over `items` with bounded concurrency, gentle on
 *  Showdown's static host (no auth, no rate-limit documented, but a few
 *  hundred ids doesn't need more than a handful of requests in flight at
 *  once). Shared by the base-dex static-sprite sweep and the alt-form sweep
 *  below — both are "HEAD/GET a sprite URL per id" workloads that just differ
 *  in what URL(s) each id probes. */
async function sweepConcurrent(items, handler, concurrency = 8) {
  const results = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.set(item, await handler(item));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Sweeps every static-tier id, checking `sprites/gen5/<id>.png`. */
async function sweepSpriteCoverage(ids) {
  console.log(`Checking sprite coverage for ${ids.length} static (#>${STATIC_THRESHOLD}) species...`);
  const results = await sweepConcurrent(ids, (id) => probeSprite(id));
  const present = new Map();
  let indeterminateCount = 0;
  for (const [id, result] of results) {
    present.set(id, result.present);
    if (result.indeterminate) indeterminateCount++;
  }
  return { present, indeterminateCount };
}

/** Sweeps alt-form candidate ids for sprite coverage, checking the animated
 *  gen5ani GIF tier first (matching how #1-649 base species render) and
 *  falling back to the static gen5 PNG tier (matching #650+). Returns a Map
 *  of id -> { tier: 'animated' | 'static' | null, indeterminate }; `tier` is
 *  null only when NEITHER tier confirmed present, meaning the candidate gets
 *  dropped entirely rather than emitted with hasSprite: false — a form that
 *  was never even a browsable row has no obligation to appear greyed out. */
async function sweepFormSpriteCoverage(ids) {
  console.log(`Checking sprite coverage for ${ids.length} alt-form candidates (gen5ani GIF, then gen5 PNG)...`);
  return sweepConcurrent(ids, async (id) => {
    const ani = await probeSprite(id, SPRITE_ANI_BASE, 'gif');
    if (ani.present) return { tier: 'animated', indeterminate: ani.indeterminate };
    const stat = await probeSprite(id, SPRITE_CHECK_BASE, 'png');
    if (stat.present) return { tier: 'static', indeterminate: stat.indeterminate };
    return { tier: null, indeterminate: ani.indeterminate || stat.indeterminate };
  });
}

/** Showdown's own pokedex.json key for a forme (e.g. "zaciancrowned") doesn't
 *  match its sprite filename (e.g. "zacian-crowned") — the sprite id is
 *  `<baseId>-<slugified forme>`, where slugifying lowercases and strips
 *  everything but a-z0-9 (so internal hyphens/apostrophes/% all collapse:
 *  "Dusk-Mane" -> "duskmane", "Pa'u" -> "pau", "10%" -> "10"). */
function slugifyForme(forme) {
  return forme.toLowerCase().replace(/[^a-z0-9]/g, '');
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

/** Name-pattern excludes for alt-battle-form candidates: regional formes
 *  (Alola/Galar/Hisui/Paldea — a separate, not-yet-scoped feature), Mega/Gmax
 *  (battle-only, mega handled by its own bespoke system elsewhere), and Totem
 *  (event-only size variants, not a pickable forme). */
const FORME_EXCLUDE_RE = /Mega|Gmax|Alola|Galar|Hisui|Paldea|Totem/i;

/** Finds every alt-battle-form worth offering in the picker: a real,
 *  non-cosmetic forme of a species that's already a dex-1025 candidate.
 *  Arceus is skipped outright — it has its own bespoke auto-cycling
 *  type-forme mechanic (arceusFormes.ts) and mixing that with this system
 *  would fight over one species. Returns { id, entry, baseId } tuples; sprite
 *  probing and hasSprite-based dropping happens separately in main(). */
function buildFormCandidates(pokedex, nameToId, candidates) {
  const found = [];
  let excludedByPattern = 0;
  let excludedCosmetic = 0;
  for (const [id, entry] of Object.entries(pokedex)) {
    if (!entry.forme || !entry.baseSpecies) continue;
    if (typeof entry.num !== 'number' || entry.num < 1 || entry.num > MAX_NUM) continue;
    if (FORME_EXCLUDE_RE.test(entry.forme)) {
      excludedByPattern++;
      continue;
    }
    if (entry.baseSpecies === 'Arceus') continue;
    const baseId = nameToId.get(entry.baseSpecies);
    if (!baseId || !candidates.has(baseId)) continue;
    const baseRaw = pokedex[baseId];
    // cosmeticFormes lists full display names ("Burmy-Sandy"), not bare
    // forme strings ("Sandy") — match against entry.name accordingly. In
    // practice this rarely fires against live Showdown data (pure-cosmetic
    // variants usually have no separate pokedex.json entry to begin with),
    // but it's the documented "no real difference" marker so it stays as a
    // guard against future data changes.
    if (baseRaw.cosmeticFormes?.includes(entry.name)) {
      excludedCosmetic++;
      continue;
    }
    found.push({ id, entry, baseId });
  }
  return { found, excludedByPattern, excludedCosmetic };
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

  // Alt-battle-form pass — entirely separate from the dexIndex/lines above.
  // Forms are never mixed into dexIndex/lines: validate()'s cycle/membership
  // checks and chainLabel()'s evolution-chain rendering assume exactly one
  // entry per dex number, and a form isn't a new dex number, it's an
  // alternate presentation of an existing one.
  console.log('');
  const { found, excludedByPattern, excludedCosmetic } = buildFormCandidates(pokedex, nameToId, candidates);
  console.log(`${found.length} alt-form candidates (excluded ${excludedByPattern} by regional/mega/gmax/totem pattern, ${excludedCosmetic} cosmetic).`);

  const formIds = found.map(({ baseId, entry }) => `${baseId}-${slugifyForme(entry.forme)}`);
  const spriteResults = await sweepFormSpriteCoverage(formIds);

  const forms = {};
  let animatedCount = 0;
  let staticOnlyCount = 0;
  let droppedNoArtCount = 0;
  for (let i = 0; i < found.length; i++) {
    const { entry, baseId } = found[i];
    const candidateId = formIds[i];
    const sprite = spriteResults.get(candidateId);
    if (sprite.tier === 'animated') animatedCount++;
    else if (sprite.tier === 'static') staticOnlyCount++;
    else {
      droppedNoArtCount++;
      continue;
    }
    forms[candidateId] = {
      id: candidateId,
      name: entry.name,
      num: entry.num,
      line: lineOf.get(baseId),
      stage: stageOf.get(baseId),
      evolvesTo: [],
      locomotion: deriveLocomotion(entry),
      hasSprite: true,
      ...(sprite.tier === 'static' ? { static: true } : {}),
      baseSpecies: baseId
    };
  }
  const orderedForms = Object.fromEntries(
    Object.values(forms)
      .sort((a, b) => a.num - b.num || a.id.localeCompare(b.id))
      .map((e) => [e.id, e])
  );

  writeFileSync(join(OUT_DIR, 'forms.json'), JSON.stringify(orderedForms, null, 2) + '\n');

  console.log(`Wrote ${Object.keys(orderedForms).length} forms to assets/dex/forms.json`);
  console.log(`  ${animatedCount} confirmed animated (gen5ani), ${staticOnlyCount} confirmed static-only (gen5), ${droppedNoArtCount} dropped (no art on either tier)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
