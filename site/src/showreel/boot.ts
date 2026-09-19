/**
 * Client-only entry for the hero showreel. Tiny on purpose: the heavy chunk
 * (Pixi + the app's garden modules + React for ArceusWarp) is a dynamic
 * import, fetched only once the hero is near the viewport, never under
 * prefers-reduced-motion (the static poster stays instead), and never on the
 * server.
 */
import type { ReelController } from './reel';

function letterboxColor(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--reel-letterbox').trim();
  const n = parseInt(raw.replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xe4d5ae;
}

function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Dev server only: @vitejs/plugin-react's fast-refresh transform of
 *  ArceusWarp.tsx expects the refresh preamble Astro only injects when a
 *  React island is on the page — and this page has none (the reel mounts
 *  React itself). Production builds have no refresh transform at all. */
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
  if (!stage) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches || !supportsWebGL()) return; // poster + static caption stay

  const scope = stage.closest('section') ?? document;
  const q = <T extends HTMLElement>(sel: string): T => scope.querySelector<T>(sel)!;
  let controller: ReelController | null = null;
  let starting = false;
  let onScreen = false;

  const syncPaused = (): void => controller?.setPaused(!onScreen || document.hidden);

  const start = async (): Promise<void> => {
    if (starting) return;
    starting = true;
    try {
      if (import.meta.env.DEV) await installReactRefreshPreamble();
      const { startReel } = await import('./reel');
      controller = await startReel(
        {
          stage,
          host: q<HTMLDivElement>('[data-reel-host]'),
          warp: q('[data-reel-warp]'),
          terminal: q('[data-reel-terminal]'),
          roster: q('[data-reel-roster]'),
          caption: q('[data-reel-caption]'),
          hud: q('[data-reel-hud]')
        },
        letterboxColor()
      );
      stage.classList.add('reel-live');
      syncPaused();
    } catch (e) {
      // Anything failing leaves the poster in place — the page still works.
      console.error('[showreel] failed to start', e);
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
  window.addEventListener('themechange', () => controller?.setBackground(letterboxColor()));
  reduce.addEventListener('change', () => {
    if (reduce.matches && controller) {
      controller.destroy();
      controller = null;
      stage.classList.remove('reel-live');
    }
  });
}
