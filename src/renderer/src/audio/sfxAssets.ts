/**
 * Bundled battle/ceremony SFX (Phase 7) — the curated subset extracted by
 * `tools/curate-sfx.cjs` into assets/audio/sfx/. Same `import.meta.glob(...,
 * { query: '?url' })` pattern `showdownArt.ts` uses for the bundled sprite
 * PNGs, for the same reason: these are real files on disk at build time, so
 * they're bundled outright rather than fetched-and-cached like music/cries.
 */
const SFX_MODULES = import.meta.glob('../../../../assets/audio/sfx/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

/** Filename (no extension) -> bundled URL, e.g. `Peck` -> `/assets/Peck-xxxx.mp3`. */
const SFX_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(SFX_MODULES)) {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.mp3$/, '');
  SFX_URLS[base] = url;
}

/** One key per curated file — see tools/curate-sfx.cjs for the source list.
 *  Keeping this as a union (rather than plain `string`) makes a typo in
 *  toolSounds.ts a compile error instead of a silent missing sound. */
export type SfxKey =
  | 'Peck'
  | 'Scratch'
  | 'Cut'
  | 'Psycho_Cut'
  | 'Mach_Punch'
  | 'Comet_Punch_1hit'
  | 'Pound'
  | 'Slam'
  | 'Gust'
  | 'Whirlwind'
  | 'Teleport'
  | 'Tackle'
  | 'Confusion'
  | 'Struggle'
  | 'Water_Gun'
  | 'Ember'
  | 'Heal_Bell'
  | 'Growth';

export function sfxUrl(key: SfxKey): string | undefined {
  return SFX_URLS[key];
}
