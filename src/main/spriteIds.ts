/**
 * Shared id-validation for anything main fetches/caches by Showdown-style
 * species id — sprites (`spriteCache.ts`) and cries (`cryCache.ts`). Both
 * build filesystem paths and fetch URLs straight from an id, so an unknown
 * id must never reach either.
 *
 * A real dex/form id is always a valid target. So is a hyphenated variant of
 * one — a mega (`charizard-megax`), an Arceus type forme (`arceus-fire`),
 * or any future forme suffix — since every one of those follows Showdown's
 * `<base-species-id>-<suffix>` convention. Rather than hand-maintain a list
 * of every such id (which is what caused the original regression: the mega
 * table in `src/renderer/src/scene/garden/megaForms.ts` has 48 ids with no
 * matching allowlist here), a hyphen-prefix check accepts any id whose
 * leading `-`-delimited prefix is itself a known dex/form key.
 */
import dexIndex from '../../assets/dex/dexIndex.json';
import forms from '../../assets/dex/forms.json';

interface DexEntryLite {
  static?: boolean;
}

// Merge in forms.json so an alt-form id (e.g. "zacian-crowned") resolves its
// `static` flag correctly too — without this, DEX[id]?.static is always
// undefined for a form (it's not in dexIndex.json at all), so `kind` in
// spriteCache.ts's fetchSpriteGif always reads 'animated' for a form
// regardless of which tier its art is actually on, a real 404 mid-render for
// every static-tier form.
export const DEX: Record<string, DexEntryLite> = {
  ...(dexIndex as unknown as Record<string, DexEntryLite>),
  ...(forms as unknown as Record<string, DexEntryLite>)
};

/** Belt-and-braces alongside the known-id check below: every real id here is
 *  lowercase alphanumeric-with-hyphens, so this also rejects a path-
 *  traversal attempt (`/`, `\`, `..`) or an embedded NUL outright. */
const VALID_ID_PATTERN = /^[a-z0-9-]+$/;

/** No real dex/form id or forme suffix comes anywhere close to this. Caps
 *  the cost of the prefix scan below and rejects absurd input outright. */
const MAX_ID_LENGTH = 64;

/** Whether `id` is a real, known species-like id — an exact dex/form entry,
 *  or a hyphenated forme/mega variant of one (`<dex-key>-<suffix>`).
 *  `Object.hasOwn` (not `in`) so inherited properties like `constructor` or
 *  `toString` can never pass as a dex key. */
export function isValidSpeciesId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
  if (!VALID_ID_PATTERN.test(id)) return false;
  if (Object.hasOwn(DEX, id)) return true;
  for (let pos = id.indexOf('-'); pos !== -1; pos = id.indexOf('-', pos + 1)) {
    if (Object.hasOwn(DEX, id.slice(0, pos))) return true;
  }
  return false;
}
