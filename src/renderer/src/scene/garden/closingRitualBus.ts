/**
 * Closing-time sunset ritual signal bus (Phase 8.5 Wave B item 2).
 *
 * Same seam pattern as `battle/battleBus.ts`: the trigger (a settings button,
 * Cmd+Shift+Q — see closingTime.ts) lives outside the garden scene, and the
 * actual walkers/overlay live inside GardenScene's Pixi effect. This tiny
 * synchronous emitter is the seam between the two, in both directions —
 * 'start'/'cancel' flow OUT to GardenScene, 'complete' flows back IN once
 * every session's walker has waved (or the 15s cap fires).
 */

export type ClosingRitualSignal =
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'complete'; wrappedCount: number };

type Listener = (signal: ClosingRitualSignal) => void;

const listeners = new Set<Listener>();

export function emitClosingRitualSignal(signal: ClosingRitualSignal): void {
  for (const l of listeners) l(signal);
}

export function onClosingRitualSignal(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
