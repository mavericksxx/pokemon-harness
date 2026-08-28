#!/usr/bin/env node
'use strict';
/**
 * Generate `src/shared/musicCatalog.json` -- the mini-player's track index
 * (Phase 7 mini-player expansion). One entry per playable track across ten
 * khinsider "game-soundtracks" albums (mainline Gen 1-9, with HGSS -- the
 * album the app already fetches tracks from, see `src/main/musicCache.ts` --
 * kept as its own `hgss` generation alongside Gen 4's D/P/Pt album).
 *
 * Only the index is checked in (id, title, khinsider track-page URL, gen) --
 * no audio. Storing each track's page URL here (rather than re-deriving it
 * from a track number at runtime, the pre-expansion approach) means
 * `ensureMusicTrack` never has to fetch-and-scan a whole album page again --
 * it goes straight from a catalog id to that track's own page, then (as
 * before) to the direct nu.vgmtreasurechest.com mp3 URL embedded in it.
 *
 * Curation: tracks under ~15s (jingles/stings -- "Level Up!", "Pokedex
 * Evaluation...", etc.) are dropped from the index UNLESS their id is one of
 * the app's pre-existing curated HGSS ids (route29, battleWild, ... --
 * `CURATED_HGSS`), so those keep resolving via ensureMusicTrack exactly as
 * before even where one of them (evolutionFanfare, a 5s fanfare) is itself
 * short enough to normally be curated out. Such forced-in entries are marked
 * `jingle: true` so the mini-player's browsable list can still exclude them.
 *
 * Run with `npm run gen:music-catalog`. Network-dependent (fetches all ten
 * album pages live); a slug that 404s or errors is skipped and reported,
 * not fatal to the rest of the run.
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT_PATH = join(__dirname, '..', 'src', 'shared', 'musicCatalog.json');

// Same UA the app's own runtime fetcher sends (musicCache.ts) -- khinsider's
// bot detection is untested against a bare Node UA, so this stays consistent
// with what's proven to work.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const DELAY_BETWEEN_ALBUMS_MS = 1500;
const JINGLE_MAX_SECONDS = 15;

/** One entry per generation's album. Order here is the order tracks are
 *  written to the index (gen1..gen4, hgss alongside gen4, then gen5..gen9). */
const ALBUMS = [
  { gen: 'gen1', slug: 'pokemon-red-green-blue-yellow', label: 'Gen 1 — R/G/B/Y' },
  { gen: 'gen2', slug: 'pokemon-gold-silver-crystal', label: 'Gen 2 — G/S/C' },
  {
    gen: 'gen3',
    slug: 'pok%C3%A9mon-ruby-sapphire-emerald-restored-soundtrack-2002',
    label: 'Gen 3 — R/S/E'
  },
  {
    gen: 'gen4',
    slug: 'pok-mon-diamond-pok-mon-pearl-super-music-collection-2006',
    label: 'Gen 4 — D/P/Pt'
  },
  { gen: 'hgss', slug: 'pokemon-heartgold-and-soulsilver', label: 'Gen 4 — HGSS' },
  { gen: 'gen5', slug: 'pokemon-black-and-white', label: 'Gen 5 — B/W' },
  { gen: 'gen6', slug: 'pokemon-x-y', label: 'Gen 6 — X/Y' },
  {
    gen: 'gen7',
    slug: 'pok%C3%A9mon-sun-pok%C3%A9mon-moon-super-music-collection-2016',
    label: 'Gen 7 — S/M'
  },
  {
    gen: 'gen8',
    slug: 'nintendo-switch-pok-mon-sword-shield-expansion-pass-super-music-collection-2024',
    label: 'Gen 8 — Sw/Sh'
  },
  {
    gen: 'gen9',
    slug: 'pok%C3%A9mon-scarlet-pok%C3%A9mon-violet-super-music-collection-expanded-complete-2024',
    label: 'Gen 9 — Sc/Vi'
  }
];

/** The app's 9 pre-existing curated HGSS ids, keyed by their 1-based row
 *  position on the HGSS album page (unchanged from the old TRACK_NUMBERS map
 *  in musicCache.ts) -- keeping these ids stable preserves users' existing
 *  on-disk caches (`<id>.mp3`) and the battle/ceremony code that references
 *  them by name. */
const CURATED_HGSS = {
  4: 'newBarkTown',
  9: 'route29',
  10: 'battleWild',
  13: 'cherrygroveCity',
  18: 'battleTrainer',
  22: 'violetCity',
  33: 'azaleaTown',
  39: 'evolutionCharge',
  40: 'evolutionFanfare'
};

const ENTITY_MAP = { amp: '&', '#039': "'", '#39': "'", nbsp: ' ', quot: '"', lt: '<', gt: '>' };
function decodeEntities(s) {
  return s.replace(/&(amp|#039|#39|nbsp|quot|lt|gt);/g, (_m, name) => ENTITY_MAP[name]);
}

function toSeconds(mmss) {
  const [m, s] = mmss.split(':').map(Number);
  return m * 60 + s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAlbumHtml(slug) {
  const url = `https://downloads.khinsider.com/game-soundtracks/album/${slug}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Parses the `#songlist` table into `{ href, title, durationSeconds }` rows.
 *  Deliberately loose: per `<tr>`, take the first clickable-row anchor for
 *  href+title, then search the whole row for the first `M:SS`-shaped anchor
 *  text for duration -- some albums lack a FLAC column or format sizes
 *  differently, but every row so far puts MP3 duration right after the title
 *  anchor. `durationSeconds` is null (not 0) when no duration is found, so
 *  curation treats "unknown" as "keep" rather than "jingle". */
function parseAlbumRows(html) {
  const tableMatch = html.match(/<table id="songlist">([\s\S]*?)<\/table>/);
  const tableHtml = tableMatch ? tableMatch[1] : html;
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(tableHtml))) {
    const row = m[1];
    const linkMatch = row.match(/class="clickable-row"><a href="([^"]+)">([^<]*)<\/a>/);
    if (!linkMatch) continue; // header/footer row, no track link
    const href = linkMatch[1];
    const title = decodeEntities(linkMatch[2]).trim();
    const durMatch = row.match(/>(\d+:\d{2})<\/a>/);
    const durationSeconds = durMatch ? toSeconds(durMatch[1]) : null;
    rows.push({ href, title, durationSeconds });
  }
  return rows;
}

async function main() {
  const catalog = [];
  const report = [];

  for (const album of ALBUMS) {
    const html = await fetchAlbumHtml(album.slug);
    if (!html) {
      report.push(`${album.gen} (${album.slug}): FETCH FAILED -- dropped`);
      await sleep(DELAY_BETWEEN_ALBUMS_MS);
      continue;
    }
    const rows = parseAlbumRows(html);
    if (rows.length === 0) {
      report.push(`${album.gen} (${album.slug}): 0 rows parsed -- dropped (layout mismatch?)`);
      await sleep(DELAY_BETWEEN_ALBUMS_MS);
      continue;
    }

    let kept = 0;
    let jinglesSkipped = 0;
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const curatedId = album.gen === 'hgss' ? CURATED_HGSS[rowNum] : undefined;
      const isJingle =
        row.durationSeconds !== null && row.durationSeconds < JINGLE_MAX_SECONDS;
      if (isJingle && !curatedId) {
        jinglesSkipped++;
        return;
      }
      const id = curatedId || `${album.gen}-${String(rowNum).padStart(3, '0')}`;
      catalog.push({
        id,
        title: row.title,
        url: row.href,
        gen: album.gen,
        jingle: isJingle
      });
      kept++;
    });
    report.push(`${album.gen} (${album.label}): ${kept} kept, ${jinglesSkipped} jingles skipped`);
    await sleep(DELAY_BETWEEN_ALBUMS_MS);
  }

  writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Wrote ${catalog.length} tracks to ${OUT_PATH}`);
  console.log(report.join('\n'));
}

main();
