import { useEffect, useState } from 'react';

/**
 * Boot screen: pokéball iris wipe (Phase 8 §8).
 *
 * `index.html` renders the IDENTICAL markup (#boot-wipe / .boot-pokeball)
 * statically, inline, before any JS runs — that's what's on screen for
 * the (variable-length) async crash/session-recovery window in main.tsx's
 * `boot()`, since React hasn't mounted yet during that work. This component
 * is the seamless handoff: its own first render matches that static markup
 * exactly (closed, `--boot-r: 0%`), so `createRoot(...).render(<App/>)`
 * replacing `#root`'s contents is invisible — same pixels, same frame, only
 * ownership changes from static HTML to React. From here it plays a brief
 * "loading beat" (the pokeball keeps wobbling in place), then the CSS
 * transition already defined in index.html's `<style>` opens the iris.
 *
 * Also covers the renderer-crash-recovery reload for free: main's
 * `render-process-gone` handler calls `loadApp()`, a FRESH page navigation
 * (see that file's comment on why, not `webContents.reload()`) — so
 * index.html is reparsed from scratch and this whole sequence just replays.
 */

/** Loading beat before the wipe starts opening, ms — brief so a fast, cache-
 *  warm boot doesn't feel gratuitous, but present so a barely-there flash
 *  doesn't register as a boot moment at all. */
const BEAT_MS = 180;
/** Must match index.html's `#boot-wipe` transition-duration. */
const WIPE_MS = 650;

export function BootWipe(): JSX.Element | null {
  const [phase, setPhase] = useState<'beat' | 'opening' | 'done'>('beat');

  useEffect(() => {
    const openTimer = window.setTimeout(() => setPhase('opening'), BEAT_MS);
    const doneTimer = window.setTimeout(() => setPhase('done'), BEAT_MS + WIPE_MS);
    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div id="boot-wipe" className={phase === 'opening' ? 'boot-wipe-open' : ''}>
      <div className="boot-pokeball">
        <div className="boot-pokeball-btn" />
      </div>
    </div>
  );
}
