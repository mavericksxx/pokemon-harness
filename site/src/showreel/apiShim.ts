/**
 * Minimal `window.api` for the app's garden modules running on the landing
 * page. In Electron this is the preload bridge (src/preload/index.ts); here
 * it only has to cover the calls the showreel's import graph actually makes:
 *
 *   lazySprites.ts        fetchSpriteGif, getCachedSprite, saveCachedSprite,
 *                         getCachedThumbnail, saveCachedThumbnail
 *   diagnosticsClient.ts  logDiagnostic
 *   evolution.ts          getEvolveSecondsOverride
 *   shiny.ts              getShinyOddsOverride
 *
 * Sprites are never fetched from Showdown at runtime: every species the
 * showreel needs outside the bundled 42 was downloaded once into
 * public/sprites/ from the same URLs main/spriteCache.ts uses
 * (gen5ani/<id>.gif, gen5ani-shiny/<id>.gif, gen5/<id>.png for static forms).
 *
 * Must be installed before any garden module is evaluated — boot.ts imports
 * this first, and ES module evaluation order is import order.
 */

/** Static (single-frame PNG) sheets among the pre-downloaded sprites. */
const STATIC_IDS = new Set(['charizard-megay']);

async function fetchSpriteGif(
  id: string,
  view: string,
  shiny: boolean,
  explicitKind?: 'animated' | 'static'
): Promise<ArrayBuffer | null> {
  if (view !== 'front' || !/^[a-z0-9-]+$/.test(id)) return null;
  const kind = explicitKind ?? (STATIC_IDS.has(id) ? 'static' : 'animated');
  const url = `/sprites/${shiny ? 'shiny/' : ''}${id}.${kind === 'static' ? 'png' : 'gif'}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

const api = {
  fetchSpriteGif,
  getCachedSprite: async (): Promise<null> => null,
  saveCachedSprite: async (): Promise<void> => {},
  getCachedThumbnail: async (): Promise<null> => null,
  saveCachedThumbnail: async (): Promise<void> => {},
  logDiagnostic: async (): Promise<void> => {},
  // "stage2s,stage3s,durationScale" — thresholds are irrelevant (the reel
  // triggers evolution itself); the third value is EvolutionCeremony's own
  // playback-speed option, sped up from the app's 0.6 default to fit a loop.
  getEvolveSecondsOverride: async (): Promise<string> => '600,1800,0.42',
  // Wild battlers roll shiny at 1-in-N; effectively never, so the one shiny
  // in the reel is the scripted one.
  getShinyOddsOverride: async (): Promise<string> => '1000000000'
};

(window as unknown as { api: typeof api }).api = api;

export {};
