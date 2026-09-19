/**
 * Mounts the app's real Hall of Origin warp (components/ArceusWarp.tsx) next
 * to the showreel's Pixi host. ArceusWarp only needs a ref to the garden host
 * (it fades that element itself at the warp midpoint) and an `ascended` flag;
 * the showreel flips the flag from its timeline. ArceusHud is not mounted —
 * it reads the app's stores — so the reel draws its own scripted dispatch log.
 */
import { createRoot, type Root } from 'react-dom/client';
import { ArceusWarp } from '@/components/ArceusWarp';

export interface ArceusStage {
  setAscended(ascended: boolean): void;
  destroy(): void;
}

export function mountArceus(container: HTMLElement, gardenHost: HTMLDivElement): ArceusStage {
  const root: Root = createRoot(container);
  const hostRef = { current: gardenHost };
  const render = (ascended: boolean): void => root.render(<ArceusWarp hostRef={hostRef} ascended={ascended} />);
  render(false);
  return {
    setAscended: render,
    destroy: () => root.unmount()
  };
}
