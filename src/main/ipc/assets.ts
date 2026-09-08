import { handle } from './handle';
import { fetchSpriteGif, getCachedSprite, saveCachedSprite } from '../spriteCache';
import { cancelPrefetch, ensureMusicTrack, getCacheStatus, prefetchTrack } from '../musicCache';
import { ensureCry } from '../cryCache';
import type { LazySpriteMeta, SpriteView } from '../../shared/types';

// No shared index.ts state — every handler here is a direct call into the
// sprite/music/cry cache modules, so this registration needs no deps.
export function registerAssetsIpc(): void {
  // ─── Lazy sprite cache (Phase 3 §2) ────────────────────────────────────────
  // Main is the only network and disk actor here: the renderer's CSP has no
  // 'unsafe-eval' script-src beyond self and no external connect-src, so it can
  // neither fetch Showdown directly nor reach outside contextBridge to touch
  // userData. Decoding/re-encoding happens renderer-side (it has a canvas).
  handle('sprites:getCached', (_e, id: string, view: SpriteView, shiny: boolean) =>
    getCachedSprite(id, view, shiny)
  );
  handle('sprites:fetchGif', (_e, id: string, view: SpriteView, shiny: boolean, explicitKind?: 'animated' | 'static') =>
    fetchSpriteGif(id, view, shiny, explicitKind)
  );
  handle(
    'sprites:saveCache',
    (_e, id: string, view: SpriteView, shiny: boolean, png: ArrayBuffer, meta: LazySpriteMeta) =>
      saveCachedSprite(id, view, shiny, png, meta)
  );

  // `id` is any mini-player catalog id (musicCatalog.ts), not just the 9
  // original curated MusicTrackIds — see musicCache.ts's header.
  handle('audio:ensureTrack', (_e, id: string) => ensureMusicTrack(id));
  handle('audio:ensureCry', (_e, id: string) => ensureCry(id));
  // Background catalog-warm (mini-player generation filter) — see
  // musicCache.ts's single-flight coordination.
  handle('audio:prefetchTrack', (_e, id: string) => prefetchTrack(id));
  handle('audio:cancelPrefetch', () => cancelPrefetch());
  handle('audio:cacheStatus', () => getCacheStatus());
}
