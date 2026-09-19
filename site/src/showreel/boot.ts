/**
 * Client-only entry for the hero showreel. Tiny on purpose: the heavy chunk
 * (Pixi, the app's garden modules and React components) is a dynamic import,
 * fetched only once the hero nears the viewport, never under
 * prefers-reduced-motion (the static poster stays instead), never on the
 * server. Also keeps the fixed 1440x900 window scaled to the hero's width.
 */
import type { ReelController } from './reel';

const DESIGN_WIDTH = 1440;
const DESIGN_HEIGHT = 900;
const MAX_RENDERED_WIDTH = 1400;

function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Dev server only: @vitejs/plugin-react's fast-refresh transform of the
 *  app's .tsx components expects the refresh preamble Astro only injects
 *  when a React island is on the page — and this page has none (the reel
 *  mounts React itself). Production builds have no refresh transform. */
async function installReactRefreshPreamble(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w.__vite_plugin_react_preamble_installed__) return;
  const runtimeUrl = '/@react-refresh';
  type Refresh = { injectIntoGlobalHook(win: Window): void };
  const mod = (await import(/* @vite-ignore */ runtimeUrl)) as Refresh & { default?: Refresh };
  (mod.default ?? mod).injectIntoGlobalHook(window);
  w.$RefreshReg$ = () => {};
  w.$RefreshSig$ = () => (type: unknown) => type;
  w.__vite_plugin_react_preamble_installed__ = true;
}

export function bootShowreel(): void {
  const stage = document.querySelector<HTMLElement>('[data-reel]');
  const scaler = document.querySelector<HTMLElement>('[data-reel-scaler]');
  if (!stage || !scaler) return;

  // Scale the fixed 1440x900 window so the WHOLE window always fits on
  // screen: within the section's width, a ~1400px cap, the viewport height
  // under the site header (minus ~60px), and — on first view — the height
  // left below the hero copy. A minimum scale applies only on narrow
  // (<700px) screens, where the width alone decides.
  const section = stage.parentElement ?? stage;
  const header = document.querySelector<HTMLElement>('.site-header');
  const fit = (): void => {
    const vh = window.innerHeight;
    const headerH = header?.offsetHeight ?? 64;
    const top = stage.getBoundingClientRect().top + window.scrollY;
    // 44px under the window leaves room for its caption line.
    const heightBudget = Math.min(vh - headerH - 60, vh - top - 44);
    let scale = Math.min(section.clientWidth / DESIGN_WIDTH, MAX_RENDERED_WIDTH / DESIGN_WIDTH, heightBudget / DESIGN_HEIGHT);
    if (window.innerWidth < 700) scale = Math.max(scale, Math.min(0.2, section.clientWidth / DESIGN_WIDTH));
    scale = Math.max(scale, 0.1);
    stage.style.width = `${Math.floor(DESIGN_WIDTH * scale)}px`;
    stage.style.height = `${Math.floor(DESIGN_HEIGHT * scale)}px`;
    scaler.style.transform = `scale(${scale})`;
  };
  fit();
  // Refit when anything above the window reflows (web fonts landing change
  // the headline's height), not just when the section itself resizes.
  const ro = new ResizeObserver(fit);
  ro.observe(section);
  ro.observe(document.body);
  void document.fonts?.ready.then(fit);
  window.addEventListener('resize', fit);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches || !supportsWebGL()) return; // poster stays

  const scope = stage.closest('section') ?? document;
  let controller: ReelController | null = null;
  let starting = false;
  let retried = false;
  let onScreen = false;

  const syncPaused = (): void => controller?.setPaused(!onScreen || document.hidden);

  const start = async (): Promise<void> => {
    if (starting) return;
    starting = true;
    try {
      if (import.meta.env.DEV) await installReactRefreshPreamble();
      const { startReel } = await import('./reel');
      controller = await startReel({
        stage,
        window: scope.querySelector<HTMLElement>('[data-reel-window]')!,
        caption: scope.querySelector<HTMLElement>('[data-reel-caption]')!
      });
      stage.classList.add('reel-live');
      syncPaused();
    } catch (e) {
      // Anything failing leaves the poster in place — the page still works.
      // One retry: a chunk fetch can fail transiently (a flaky connection, or
      // the dev server re-optimizing deps on a cold load).
      console.error('[showreel] failed to start', e);
      if (!retried) {
        retried = true;
        starting = false;
        window.setTimeout(() => void start(), 1500);
      }
    }
  };

  new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) void start();
      syncPaused();
    },
    { rootMargin: '200px 0px' }
  ).observe(stage);
  document.addEventListener('visibilitychange', syncPaused);
  reduce.addEventListener('change', () => {
    if (reduce.matches && controller) {
      controller.destroy();
      controller = null;
      stage.classList.remove('reel-live');
    }
  });
}
