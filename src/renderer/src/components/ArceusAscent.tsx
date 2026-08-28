import { useEffect, useRef, useState, type RefObject } from 'react';
import { ARCEUS_FORMES, ARCEUS_FORME_HOLD_MS } from '@/scene/garden/arceusFormes';
import { loadLazyThumbnail } from '@/scene/garden/lazySprites';
import { nebulaDataUrl } from '@/scene/garden/nebula';

interface Props {
  /** `.garden` — the Pixi canvas host in GardenScene.tsx. This component
   *  drives ITS transform too (the liftoff/descent), not just its own two
   *  new layers, so the three stay in lockstep under one progress value. */
  hostRef: RefObject<HTMLDivElement>;
  ascended: boolean;
}

const ASCEND_MS = 1200;
const DESCEND_MS = 800;
/** Phase boundaries as fractions of the full 0..1 progress range — same
 *  proportions used for both directions (only the total duration differs
 *  between ascend/descend; see this file's header for why that's an
 *  acceptable simplification over two fully independent curves). Liftoff
 *  ~250ms, rush ~650ms, arrival ~300ms of the 1200ms ascent. */
const LIFTOFF_END = 250 / ASCEND_MS;
const RUSH_END = (250 + 650) / ASCEND_MS;

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
  const cosmosRef = useRef<HTMLDivElement>(null);
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
      const cosmos = cosmosRef.current;
      if (!host || !rush || !cosmos) return;

      const liftoffT = easeInCubic(clamp01(p / LIFTOFF_END));
      host.style.transform = `translateY(${lerp(0, 100, liftoffT)}%) scale(${lerp(1, 0.92, liftoffT)})`;

      const rushIn = clamp01(p / (LIFTOFF_END * 0.6));
      const rushOut = clamp01((p - RUSH_END) / (1 - RUSH_END));
      const rushOpacity = p >= RUSH_END ? 1 - rushOut : rushIn;
      rush.style.opacity = String(rushOpacity);
      rush.style.background = skyColorAt(clamp01(p / RUSH_END));

      const arrivalT = easeOutCubic(clamp01((p - RUSH_END) / (1 - RUSH_END)));
      cosmos.style.opacity = String(arrivalT);
      cosmos.style.transform = `translateY(${lerp(8, 0, arrivalT)}%)`;
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
    </>
  );
}
