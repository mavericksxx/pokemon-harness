import { useEffect, useRef, useState, type RefObject } from 'react';
import { ARCEUS_FORMES, ARCEUS_FORME_HOLD_MS } from '@/scene/garden/arceusFormes';
import { loadLazyThumbnail } from '@/scene/garden/lazySprites';
import { nebulaDataUrl } from '@/scene/garden/nebula';
import { coverFrameUrls, warpStreakFrameUrls, type WarpDirection } from '@/scene/garden/warpStreaks';

interface Props {
  /** `.garden` — the Pixi canvas host in GardenScene.tsx. This component
   *  toggles ITS visibility too (garden <-> cosmos), not just its own
   *  layers, so the scene swap happens in lockstep with the flash. */
  hostRef: RefObject<HTMLDivElement>;
  ascended: boolean;
}

/** Total warp duration, one direction — short and snappy per the design
 *  brief (~600-900ms), the SAME both ways (unlike the old ascent, which
 *  used a slower ascend and a faster descend): a warp reads the same
 *  whichever way it's run. */
const WARP_MS = 720;

/** Progress is a single continuous 0..1 value (0 = garden, 1 = cosmos) —
 *  same "one driver, not two CSS animations" approach the old ascent used,
 *  and for the same reason: it's what makes the warp INTERRUPTIBLE
 *  (flipping the target mid-flight just reverses direction from wherever
 *  progress currently sits, no stuck state, no snap). The scene swap
 *  (`.garden` <-> `.garden-cosmos` visibility) happens at the p=0.5
 *  crossing, which is also where the flash and streak burst both peak —
 *  see `applyStyles` — so it's never a visible pop. */
function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/** Flash timing, in progress units from p=0.5. Full cover holds out to
 *  FLASH_FULL on each side (a plateau, not a single-frame peak) — needed
 *  because rAF steps by ~dt/WARP_MS per frame (≈0.023 at 60fps, more on a
 *  hitch) and will almost never land exactly on 0.5, so a sharp tent peak
 *  would leave the actual swap frame under full cover and let the scene
 *  swap show through. Fully gone by FLASH_EDGE. The `step` function below
 *  additionally forces full cover on any frame that crosses p=0.5 outright
 *  (a big hitch can jump clean over this window in one tick), so the swap
 *  is never visible even on a dropped frame. */
const FLASH_FULL = 0.06;
const FLASH_EDGE = 0.13;

/**
 * The Arceus warp (replaces the old vertical "ascent" — ArceusAscent.tsx,
 * deleted). A Pokémon-style teleport: a radial pixel-streak burst
 * (warpStreaks.ts) converges toward center, a blocky Bayer-dissolve cover
 * marks the midpoint (exactly where `.garden` and `.garden-cosmos` swap
 * visibility, so the swap is never seen), then the burst diverges back out
 * revealing the destination. Symmetric in both directions — selecting
 * Arceus warps garden -> cosmos, selecting a regular agent while in the
 * cosmos warps back cosmos -> garden — with only the streak/cover color
 * differing (violets going up, garden greens/golds coming down) as a
 * direction cue.
 *
 * Both layers are FRAME-FLIPPED (`background-image` swaps between a small,
 * fixed set of pre-rasterized frames from warpStreaks.ts — never `transform:
 * scale` or an animated opacity gradient on one texture): every frame maps
 * onto the pane the same fixed way, so there's never a fractional scale
 * factor producing uneven pixel blocks, and the low frame count (`applyStyles`
 * below) reads as a stepped, low-framerate game transition rather than a
 * smooth CSS tween.
 */
export function ArceusWarp({ hostRef, ascended }: Props): JSX.Element {
  const cosmosRef = useRef<HTMLDivElement>(null);
  const streaksRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  // Two-slot crossfade — `urls[active]` is fully visible, `urls[1-active]`
  // is the OUTGOING (or not-yet-populated) slot. Both start null: nothing
  // renders until the base forme's own thumbnail has actually resolved
  // (never a placeholder/loading flash — see this file's header on why
  // this bypasses PokemonFace's own null-while-loading state entirely).
  const [display, setDisplay] = useState<{ urls: [string | null, string | null]; active: 0 | 1 }>({
    urls: [null, null],
    active: 0
  });
  const formeIndexRef = useRef(0);
  // Resolved-thumbnail cache, keyed by forme id — `loadLazyThumbnail`
  // already caches internally, but awaiting it again is still an async
  // hop; this lets an already-resolved forme swap in synchronously-ish
  // (same tick the interval fires) instead of a needless extra await.
  const urlCacheRef = useRef(new Map<string, string>());

  const resolveForme = async (id: string): Promise<string | null> => {
    const cached = urlCacheRef.current.get(id);
    if (cached) return cached;
    const url = await loadLazyThumbnail(id);
    if (url) urlCacheRef.current.set(id, url);
    return url;
  };

  useEffect(() => {
    try {
      reducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* ignore */
    }
  }, []);

  // Prewarm BOTH directions' frame sets once, right after mount — the
  // transition effect below only generates the direction it's about to
  // play, which (memoized per-direction) means the FIRST real toggle to
  // whichever direction wasn't already warmed pays every frame's raster
  // cost synchronously, in the same tick that kicks off the warp's rAF
  // loop — a stall right at the start of an animation. Priming both here,
  // off the animation path, means neither direction's frames are ever
  // generated for the first time mid-transition.
  useEffect(() => {
    warpStreakFrameUrls('up');
    warpStreakFrameUrls('down');
    coverFrameUrls('up');
    coverFrameUrls('down');
  }, []);

  // First summon: show the base forme only once ITS thumbnail is actually
  // ready (the warp's own flash gives this cover — by the time the cosmos
  // layer is visibly opaque, this has almost always resolved). Warms the
  // NEXT forme in the background right after, so the very first cycle swap
  // never waits either.
  useEffect(() => {
    let cancelled = false;
    void resolveForme(ARCEUS_FORMES[0]).then((url) => {
      if (cancelled || !url) return;
      setDisplay({ urls: [url, null], active: 0 });
      void resolveForme(ARCEUS_FORMES[1]);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately mount-only: `resolveForme` closes over refs, not props/
    // state, so it never needs to be in this effect's dep list.
  }, []);

  // Forme cycling — independent of the warp progress; the plate keeps
  // cycling whether or not he's currently on-screen (cheap: it's just a
  // cached thumbnail swap). Frozen on the first forme under reduced
  // motion. The next forme is fully fetched+decoded+cached BEFORE the
  // visible swap happens (`await resolveForme` first, THEN update state) —
  // the current forme keeps showing the whole time it's in flight, so
  // there's never an intermediate empty/placeholder frame; the forme AFTER
  // that is warmed in the background right after each swap so a cycle
  // never has to wait on a cold fetch.
  useEffect(() => {
    if (reducedMotionRef.current) return;
    const id = window.setInterval(() => {
      void (async () => {
        const nextIndex = (formeIndexRef.current + 1) % ARCEUS_FORMES.length;
        const url = await resolveForme(ARCEUS_FORMES[nextIndex]);
        if (!url) return; // fetch failed — keep showing the current forme, retry next cycle
        formeIndexRef.current = nextIndex;
        setDisplay((prev) => {
          const incoming = prev.active === 0 ? 1 : 0;
          const urls: [string | null, string | null] = [...prev.urls];
          urls[incoming] = url;
          return { urls, active: incoming };
        });
        void resolveForme(ARCEUS_FORMES[(nextIndex + 1) % ARCEUS_FORMES.length]);
      })();
    }, ARCEUS_FORME_HOLD_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const cosmos = cosmosRef.current;
    const streaks = streaksRef.current;
    const flash = flashRef.current;
    if (!host || !cosmos || !streaks || !flash) return;

    const direction: WarpDirection = ascended ? 'up' : 'down';
    const streakFrames = warpStreakFrameUrls(direction);
    const coverFrames = coverFrameUrls(direction);
    const lastStreakIndex = streakFrames.length - 1;
    const lastCoverLevel = coverFrames.length - 1;

    // `forceFullCover`: true on any rAF tick whose progress step crossed (or
    // landed exactly on) p=0.5 — belt-and-braces alongside the FLASH_FULL
    // plateau below, since a big hitch can step clean over that window in
    // one tick and the scene swap must never be visible.
    const applyStyles = (p: number, forceFullCover: boolean): void => {
      const showCosmos = p >= 0.5;
      host.style.opacity = showCosmos ? '0' : '1';
      host.style.pointerEvents = showCosmos ? 'none' : 'auto';
      cosmos.style.opacity = showCosmos ? '1' : '0';

      // Streak burst: frame-indexed by distance from the midpoint (0 =
      // converged, near p=0.5; the last frame = fully spread, near p=0/1)
      // — background-image swaps between whole pre-rasterized frames
      // (warpStreaks.ts), never a CSS `transform: scale` on one texture, so
      // every frame is crisp by construction with no fractional scale
      // factor to produce uneven pixel blocks.
      const distFromCenter = clamp01(Math.abs(p - 0.5) / 0.5);
      const streakIndex = Math.min(lastStreakIndex, Math.floor(distFromCenter * streakFrames.length));
      streaks.style.backgroundImage = `url(${streakFrames[streakIndex]})`;
      // Three fixed opacity tiers (not a gradient) keyed off the same
      // index: full strength through the mid-reach frames, half strength
      // one step before fully spread, gone at fully spread — so the
      // widest-reach frame (the most ink in the set) never pops in at full
      // strength over an otherwise-untouched scene.
      streaks.style.opacity =
        streakIndex >= lastStreakIndex ? '0' : streakIndex === lastStreakIndex - 1 ? '0.5' : '1';

      // Cover dissolve: Bayer-ordered flat cells fill in as p approaches
      // 0.5, hold at full cover through the FLASH_FULL plateau (or when
      // `forceFullCover` catches a hitch), then empty back out — this is
      // what hides the `.garden`/`.garden-cosmos` swap.
      const flashDist = Math.abs(p - 0.5);
      let coverLevel: number;
      if (forceFullCover || flashDist <= FLASH_FULL) {
        coverLevel = lastCoverLevel;
      } else if (flashDist >= FLASH_EDGE) {
        coverLevel = 0;
      } else {
        const t = (FLASH_EDGE - flashDist) / (FLASH_EDGE - FLASH_FULL);
        coverLevel = Math.min(lastCoverLevel, Math.round(t * lastCoverLevel));
      }
      flash.style.backgroundImage = `url(${coverFrames[coverLevel]})`;
    };

    const target = ascended ? 1 : 0;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    if (reducedMotionRef.current) {
      // No streak burst / flash under reduced motion — just a short fade
      // between the two scenes, per the design brief.
      host.style.transition = 'opacity 150ms ease';
      cosmos.style.transition = 'opacity 150ms ease';
      progressRef.current = target;
      applyStyles(target, false);
      return;
    }

    host.style.transition = '';
    cosmos.style.transition = '';

    if (progressRef.current === target) {
      applyStyles(target, false);
      return;
    }

    let last = performance.now();
    const step = (now: number): void => {
      const dt = now - last;
      last = now;
      const dir = target >= progressRef.current ? 1 : -1;
      const prevP = progressRef.current;
      progressRef.current = clamp01(progressRef.current + (dir * dt) / WARP_MS);
      const crossedMidpoint = (prevP - 0.5) * (progressRef.current - 0.5) <= 0;
      applyStyles(progressRef.current, crossedMidpoint);
      rafRef.current = progressRef.current === target ? null : requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ascended, hostRef]);

  return (
    <>
      <div className="garden-cosmos" ref={cosmosRef} aria-hidden="true">
        <div className="garden-cosmos-nebula" style={{ backgroundImage: `url(${nebulaDataUrl()})` }} />
        <div className="garden-cosmos-figure">
          {/* Two stacked slots, crossfading via CSS `transition: opacity` —
              never PokemonFace's own null-while-loading placeholder (see
              this file's header): a slot only ever gets a `background-
              image` once its thumbnail has actually resolved. */}
          {([0, 1] as const).map((slot) => (
            <div
              key={slot}
              className="garden-cosmos-forme"
              style={{
                backgroundImage: display.urls[slot] ? `url(${display.urls[slot]})` : undefined,
                opacity: display.active === slot ? 1 : 0
              }}
            />
          ))}
        </div>
      </div>
      <div className="garden-warp-streaks" ref={streaksRef} aria-hidden="true" />
      <div className="garden-warp-flash" ref={flashRef} aria-hidden="true" />
    </>
  );
}
