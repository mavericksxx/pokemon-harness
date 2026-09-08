/**
 * Closing-time sunset ritual orchestrator (Phase 8.5 Wave B item 2) — the
 * non-garden half. Triggered from SettingsPanel.tsx's "Closing time" button
 * or App.tsx's Cmd+Shift+Q; the walk/wave/overlay mechanics live in
 * GardenScene.tsx + ClosingRitual.ts, reached over closingRitualBus.ts.
 *
 * Flow: emit 'start' -> wait for the bus's 'complete' signal (every walker
 * waved, or ClosingRitual's own 15s cap fired) -> toast the wrapped-up count
 * -> fade the music/SFX bus out -> `app.quit()`. `before-quit` (main/index.ts)
 * already kills every PTY and stops the hook/cost-watcher servers — nothing
 * extra needed here for "ptys killed gracefully".
 */
import { emitClosingRitualSignal, onClosingRitualSignal } from '@/scene/garden/closingRitualBus';
import { useStore } from '@/store/store';
import { Howler } from '@/audio/audioEngine';

let running = false;
// Set the instant the 'complete' signal lands (i.e. right where `running`
// used to flip back to false) and left true through the ~900ms audio fade
// until `quitApp()` actually fires — see `isClosingTimeActive`/
// `cancelClosingTime` below for why that window can't be treated as "no
// ritual in progress" just because the walk/wave/overlay part is done.
let quitting = false;

export function isClosingTimeActive(): boolean {
  return running || quitting;
}

export function startClosingTime(): void {
  if (running || quitting) return;
  running = true;
  // The settings panel binds its own Escape handler (closes itself) — leave
  // it open and Escape would just close the panel instead of cancelling the
  // ritual. Close it up front so the App-level Escape handler (which checks
  // isClosingTimeActive()) is the only one left listening.
  useStore.getState().setSettingsOpen(false);

  const off = onClosingRitualSignal((signal) => {
    if (signal.type !== 'complete') return;
    off();
    // Bug fix: this used to drop straight to `running = false` here, ~900ms
    // before `fadeAudioThenQuit` below actually calls `quitApp()` — in that
    // window, `isClosingTimeActive()` already read false, so App.tsx's
    // Escape handler (which only calls `cancelClosingTime` while active) was
    // a dead letter, and a second Cmd+Shift+Q passed `startClosingTime`'s own
    // re-entry guard and kicked off a whole second ritual on top of the
    // quit that was already committed. `quitting` keeps this window
    // "active" (Escape/a second shortcut both still see it that way) while
    // still telling `cancelClosingTime` below that it's too late to actually
    // cancel anything.
    running = false;
    quitting = true;
    const n = signal.wrappedCount;
    useStore.getState().pushToast(`${n} session${n === 1 ? '' : 's'} wrapped up.`);
    fadeAudioThenQuit();
  });

  emitClosingRitualSignal({ type: 'start' });
}

export function cancelClosingTime(): void {
  // Once the fade-to-quit is underway there is nothing left to cancel — the
  // quit is already committed (see `quitting`'s own comment above) — so this
  // is a no-op rather than emitting a 'cancel' signal the ritual bus has no
  // in-flight ritual left to apply it to.
  if (quitting) return;
  if (!running) return;
  running = false;
  emitClosingRitualSignal({ type: 'cancel' });
}

const FADE_MS = 900;
const FADE_STEPS = 9;

function fadeAudioThenQuit(): void {
  const startVolume = Howler.volume();
  let step = 0;
  const iv = window.setInterval(() => {
    step++;
    Howler.volume(Math.max(0, startVolume * (1 - step / FADE_STEPS)));
    if (step >= FADE_STEPS) {
      window.clearInterval(iv);
      void window.api.quitApp();
    }
  }, FADE_MS / FADE_STEPS);
}

/**
 * Quit-intercept dialog (parity sweep item 2) — main asks the renderer to
 * show the "N agents still running" dialog whenever a close/quit was
 * prevented because sessions are live (see main/index.ts's `close` and
 * `before-quit` guards). Call once, at boot.
 *
 * Ignores the request while the sunset ritual is already running: main's
 * guard can't see the ritual's in-flight state, so a Cmd+Q pressed mid-
 * ritual would otherwise pop this dialog OVER the sunset overlay — the
 * ritual is already headed for a confirmed quit (`app:quit`, which sets
 * `quitConfirmed` main-side) and doesn't need a second confirmation.
 */
export function startQuitInterceptListener(): void {
  window.api.onQuitRequested((count) => {
    if (isClosingTimeActive()) return;
    useStore.getState().setQuitDialogOpen(true, count);
  });
}
