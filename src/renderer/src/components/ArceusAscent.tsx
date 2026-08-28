import { useEffect, useRef, useState, type RefObject } from 'react';
import { ARCEUS_FORMES, ARCEUS_FORME_HOLD_MS } from '@/scene/garden/arceusFormes';
import { cloudSprite } from '@/scene/garden/clouds';
import { loadLazyThumbnail } from '@/scene/garden/lazySprites';
import { nebulaDataUrl } from '@/scene/garden/nebula';

interface Props {
  /** `.garden` — the Pixi canvas host in GardenScene.tsx. This component
   *  drives ITS transform too (the liftoff/descent), not just its own two
   *  new layers, so the three stay in lockstep under one progress value. */
  hostRef: RefObject<HTMLDivElement>;
  ascended: boolean;
}

const ASCEND_MS = 1400;
const DESCEND_MS = 950;
/** Phase boundaries as fractions of the full 0..1 progress range — same
 *  proportions used for both directions (only the total duration differs
 *  between ascend/descend; see this file's header for why that's an
 *  acceptable simplification over two fully independent curves). Liftoff
 *  ~250ms, rush ~550ms, arrival ~600ms of the 1400ms ascent — arrival is
 *  the cloud-cover-then-part reveal (COVER_HOLD_END/below), not a plain
 *  fade, so it needs more room than the original 300ms. */
const LIFTOFF_END = 250 / ASCEND_MS;
const RUSH_END = (250 + 550) / ASCEND_MS;
/** The cloud cover fades in over the last stretch of rush, holds briefly
 *  once fully ascended, then PARTS (slides apart) over the remainder —
 *  see `applyStyles`. ~130ms hold + ~400ms part, both scaled by whichever
 *  direction's total duration is currently in effect (ascend vs descend). */
const COVER_HOLD_END = RUSH_END + 130 / ASCEND_MS;

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}
function easeInCubic(t: number): number {
  return t * t * t;
}
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bl = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r}, ${g}, ${bl})`;
}

// Day blue -> dusk violet -> deep indigo (matches the cosmos backdrop's own
// base color at t=1, so the rush layer hands off to it with no visible seam).
const SKY_DAY: [number, number, number] = [111, 168, 220];
const SKY_DUSK: [number, number, number] = [90, 62, 130];
const SKY_DEEP: [number, number, number] = [11, 11, 36];

function skyColorAt(t: number): string {
  return t < 0.5 ? lerpColor(SKY_DAY, SKY_DUSK, t / 0.5) : lerpColor(SKY_DUSK, SKY_DEEP, (t - 0.5) / 0.5);
}

/** Fixed, hand-placed speed-line seeds (left%, height px, base opacity,
 *  negative animation-delay so they don't all move in lockstep) — a static
 *  generated set, not re-randomized per render. */
const STREAKS: readonly { left: number; height: number; opacity: number; delayMs: number; durationMs: number }[] = [
  { left: 6, height: 60, opacity: 0.5, delayMs: -80, durationMs: 520 },
  { left: 14, height: 90, opacity: 0.35, delayMs: -260, durationMs: 480 },
  { left: 22, height: 40, opacity: 0.6, delayMs: -410, durationMs: 560 },
  { left: 31, height: 110, opacity: 0.3, delayMs: -120, durationMs: 500 },
  { left: 39, height: 55, opacity: 0.45, delayMs: -340, durationMs: 540 },
  { left: 48, height: 75, opacity: 0.4, delayMs: -20, durationMs: 470 },
  { left: 57, height: 95, opacity: 0.55, delayMs: -190, durationMs: 590 },
  { left: 65, height: 45, opacity: 0.35, delayMs: -450, durationMs: 510 },
  { left: 73, height: 65, opacity: 0.5, delayMs: -300, durationMs: 530 },
  { left: 81, height: 85, opacity: 0.3, delayMs: -60, durationMs: 500 },
  { left: 89, height: 50, opacity: 0.45, delayMs: -370, durationMs: 550 },
  { left: 94, height: 70, opacity: 0.4, delayMs: -230, durationMs: 480 }
];

/** Fixed, hand-placed cloud-puff seeds — chunky cumulus-dome-cluster puffs
 *  (scene/garden/clouds.ts) whipping past during rush, foreground (bigger/
 *  faster/more opaque) and background (smaller/slower/fainter) mixed for
 *  cheap depth. Static generated set, not re-randomized per render — same
 *  convention as STREAKS above. Shape itself is the shared `.puff-shape`
 *  CSS class (index.css) with a per-puff `background-image` — see the
 *  `cloudSprite` call below, and `RUSH_SATELLITE_MAX_SIZE` for which of
 *  these render as a small satellite mini-puff vs. a full hero cluster. */
const CLOUD_PUFFS: readonly { left: number; size: number; opacity: number; delayMs: number; durationMs: number }[] = [
  { left: 10, size: 46, opacity: 0.5, delayMs: -120, durationMs: 900 },
  { left: 28, size: 30, opacity: 0.3, delayMs: -480, durationMs: 1300 },
  { left: 46, size: 54, opacity: 0.55, delayMs: -280, durationMs: 850 },
  { left: 63, size: 26, opacity: 0.28, delayMs: -650, durationMs: 1400 },
  { left: 78, size: 42, opacity: 0.45, delayMs: -60, durationMs: 950 },
  { left: 90, size: 32, opacity: 0.32, delayMs: -380, durationMs: 1250 }
];

/** Below this size, a rush puff renders as a small 1-2-dome satellite
 *  mini-puff (cloudSprite's `satellite` flag) rather than a full 3-6-dome
 *  hero cluster — splits CLOUD_PUFFS' own size range roughly in half (26,
 *  30, 32 vs. 42, 46, 54), so both read among the six whipping past. */
const RUSH_SATELLITE_MAX_SIZE = 36;

/** The arrival cover bank (Phase 8.8 §4, reworked per design feedback — a
 *  "sky opening around him," not two doors sliding shut) — many individual
 *  puffs spread across the pane (some starting slightly past 0%/100% so
 *  the bank still reads as unbroken before it clears), each with its own
 *  size/vertical seat/shade tone. Left near the horizontal CENTER (close
 *  to `left: 50`) clear FIRST; edge puffs clear last — see `applyStyles`'
 *  per-puff stagger, computed from each one's own distance from center
 *  rather than a hand-authored delay, so this array only needs to place
 *  them, not time them. The four smallest (44-52, see
 *  `COVER_SATELLITE_MAX_SIZE`) sit near the top, beside/above larger
 *  clusters — small satellite puffs beside hero clouds, per the reference. */
const COVER_SATELLITE_MAX_SIZE = 56;
const COVER_PUFFS: readonly { left: number; top: number; size: number; tone: 'light' | 'mid' | 'dim' }[] = [
  { left: 50, top: 42, size: 92, tone: 'light' },
  { left: 38, top: 56, size: 72, tone: 'mid' },
  { left: 63, top: 58, size: 76, tone: 'mid' },
  { left: 27, top: 34, size: 60, tone: 'dim' },
  { left: 74, top: 36, size: 64, tone: 'dim' },
  { left: 17, top: 60, size: 66, tone: 'mid' },
  { left: 83, top: 62, size: 68, tone: 'mid' },
  { left: 7, top: 42, size: 56, tone: 'light' },
  { left: 93, top: 45, size: 58, tone: 'light' },
  { left: 44, top: 20, size: 50, tone: 'dim' },
  { left: 57, top: 23, size: 52, tone: 'dim' },
  { left: 14, top: 18, size: 44, tone: 'mid' },
  { left: 86, top: 20, size: 46, tone: 'mid' },
  { left: -3, top: 50, size: 62, tone: 'light' },
  { left: 103, top: 50, size: 62, tone: 'light' }
];

/**
 * The cosmos ascent (Phase 8.8 §4) — a three-phase vertical launch: liftoff
 * (the garden drops away, accelerating), rush (a sky transit with pixel
 * speed-lines and a day→dusk→indigo color ramp — the "blur" reinterpreted
 * as motion streaks, never a CSS/gaussian blur), arrival (decelerate,
 * streaks fade, the nebula + Arceus settle in). Descent plays the same
 * mapping in reverse, faster.
 *
 * Driven by a single continuous `progress` (0 = garden, 1 = cosmos) rather
 * than three separate CSS animations, specifically so it's INTERRUPTIBLE:
 * flipping the target mid-flight (the user selects a different session
 * while ascending) just reverses direction from wherever `progress`
 * currently sits — no stuck state, no snap. `prefers-reduced-motion` skips
 * the rAF loop entirely and jumps straight to the target's styles, which
 * also means the rush layer (only ever non-zero mid-transition) never
 * becomes visible — no separate "no streaks" branch needed.
 */
export function ArceusAscent({ hostRef, ascended }: Props): JSX.Element {
  const rushRef = useRef<HTMLDivElement>(null);
  const cloudsRef = useRef<HTMLDivElement>(null);
  const cosmosRef = useRef<HTMLDivElement>(null);
  // One ref per COVER_PUFFS entry, same index — populated via callback
  // refs in the JSX below.
  const coverPuffRefs = useRef<(HTMLSpanElement | null)[]>([]);
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

  // First summon: show the base forme only once ITS thumbnail is actually
  // ready (the ascent's own arrival timing gives this cover — by the time
  // the cosmos layer is visibly opaque, this has almost always resolved).
  // Warms the NEXT forme in the background right after, so the very first
  // cycle swap never waits either.
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

  // Forme cycling — independent of the ascent progress; the plate keeps
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
    const applyStyles = (p: number): void => {
      const host = hostRef.current;
      const rush = rushRef.current;
      const clouds = cloudsRef.current;
      const cosmos = cosmosRef.current;
      if (!host || !rush || !clouds || !cosmos) return;

      const liftoffT = easeInCubic(clamp01(p / LIFTOFF_END));
      host.style.transform = `translateY(${lerp(0, 100, liftoffT)}%) scale(${lerp(1, 0.92, liftoffT)})`;

      const rushIn = clamp01(p / (LIFTOFF_END * 0.6));
      const rushOut = clamp01((p - RUSH_END) / (1 - RUSH_END));
      const rushOpacity = p >= RUSH_END ? 1 - rushOut : rushIn;
      rush.style.opacity = String(rushOpacity);
      rush.style.background = skyColorAt(clamp01(p / RUSH_END));

      // Cloud puffs: density peaks mid-rush, thins as the sky nears indigo
      // (clouds don't belong in space — gone before the cover/nebula show).
      const cloudPeak = clamp01(p / (RUSH_END * 0.55));
      const cloudFade = clamp01((p - RUSH_END * 0.75) / (RUSH_END * 0.25));
      clouds.style.opacity = String(Math.min(cloudPeak, 1 - cloudFade));

      // Nebula + Arceus are fully rendered and ready WELL before the cover
      // parts (see this file's header — no placeholder ever visible behind
      // it): opacity reaches 1 almost immediately after rush ends, long
      // before COVER_HOLD_END.
      const cosmosReadyT = clamp01((p - RUSH_END) / (RUSH_END * 0.14));
      cosmos.style.opacity = String(cosmosReadyT);

      // The cloud-cover reveal — the arrival beat itself, replacing a plain
      // fade-in: the bank fades to fully opaque right at the tail of rush,
      // holds briefly once ascended, then CLEARS. "Clears" is per-puff, not
      // a shared transform — see the loop below.
      const coverInT = easeOutCubic(clamp01((p - (RUSH_END - 0.04)) / (COVER_HOLD_END - (RUSH_END - 0.04))));
      const partT = clamp01((p - COVER_HOLD_END) / (1 - COVER_HOLD_END));
      const bankOpacity = p <= COVER_HOLD_END ? coverInT : 1;

      // Sky opens from the MIDDLE outward: each puff's own distance from
      // horizontal center sets how much of `partT` it waits out before it
      // starts clearing — center puffs (dist~0) start immediately, edge
      // puffs (dist~1) wait out up to STAGGER_SPAN of the window — so nT
      // puffs are, unlike a shared transform, never in lockstep. Each
      // clears by fading out while drifting toward ITS OWN side and
      // shrinking slightly, reading as dissolving into sky rather than
      // sliding off like a panel.
      const STAGGER_SPAN = 0.62;
      for (let i = 0; i < COVER_PUFFS.length; i++) {
        const el = coverPuffRefs.current[i];
        if (!el) continue;
        const puff = COVER_PUFFS[i];
        const dist = clamp01(Math.abs(puff.left - 50) / 53);
        const side = puff.left >= 50 ? 1 : -1;
        const localT = easeInCubic(clamp01((partT - dist * STAGGER_SPAN) / (1 - dist * STAGGER_SPAN)));
        el.style.opacity = String(bankOpacity * (1 - localT));
        el.style.transform = `translate(${side * lerp(0, 46, localT)}px, ${lerp(0, -14, localT)}px) scale(${lerp(1, 0.72, localT)})`;
      }
    };

    const target = ascended ? 1 : 0;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    if (reducedMotionRef.current) {
      progressRef.current = target;
      applyStyles(target);
      return;
    }

    const durationMs = ascended ? ASCEND_MS : DESCEND_MS;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = now - last;
      last = now;
      const dir = target >= progressRef.current ? 1 : -1;
      progressRef.current = clamp01(progressRef.current + (dir * dt) / durationMs);
      applyStyles(progressRef.current);
      rafRef.current = progressRef.current === target ? null : requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ascended, hostRef]);

  return (
    <>
      <div className="garden-rush" ref={rushRef} aria-hidden="true">
        {STREAKS.map((s, i) => (
          <span
            key={i}
            className="garden-rush-streak"
            style={{
              left: `${s.left}%`,
              height: `${s.height}px`,
              opacity: s.opacity,
              animationDelay: `${s.delayMs}ms`,
              animationDuration: `${s.durationMs}ms`
            }}
          />
        ))}
      </div>
      <div className="garden-rush-clouds" ref={cloudsRef} aria-hidden="true">
        {CLOUD_PUFFS.map((c, i) => {
          const sprite = cloudSprite(c.left * 1000 + c.size, c.size, c.size < RUSH_SATELLITE_MAX_SIZE);
          return (
            <span
              key={i}
              className="puff-shape garden-rush-puff"
              style={{
                left: `${c.left}%`,
                width: `${c.size}px`,
                height: `${c.size * sprite.aspect}px`,
                backgroundImage: `url(${sprite.url})`,
                opacity: c.opacity,
                animationDelay: `${c.delayMs}ms`,
                animationDuration: `${c.durationMs}ms`
              }}
            />
          );
        })}
      </div>
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
      {/* The arrival reveal (Phase 8.8 §4 revision) — a bank of individual
          puffs covering the cosmos fully, holding briefly, then clearing
          from the middle outward (per-puff stagger in `applyStyles`, not a
          shared transform — see this file's header). Sits ABOVE
          `.garden-cosmos` in the DOM (later = on top), so it's genuinely
          occluding the (already fully loaded) nebula/Arceus underneath,
          not just an opacity trick. */}
      <div className="garden-cloud-cover" aria-hidden="true">
        {COVER_PUFFS.map((c, i) => {
          const sprite = cloudSprite(c.left * 1000 + c.size, c.size, c.size < COVER_SATELLITE_MAX_SIZE);
          const height = c.size * sprite.aspect;
          return (
            <span
              key={i}
              ref={(el) => {
                coverPuffRefs.current[i] = el;
              }}
              className={`puff-shape garden-cloud-cover-puff ${c.tone}`}
              style={{
                left: `${c.left}%`,
                top: `${c.top}%`,
                width: `${c.size}px`,
                height: `${height}px`,
                backgroundImage: `url(${sprite.url})`,
                marginLeft: `${-c.size / 2}px`,
                marginTop: `${-height / 2}px`
              }}
            />
          );
        })}
      </div>
    </>
  );
}
