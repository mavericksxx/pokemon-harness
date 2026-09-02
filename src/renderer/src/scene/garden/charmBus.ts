/**
 * Garden-charm signal bus (in-app demo mode) — same seam pattern as
 * `closingRitualBus.ts`: the trigger (demo.ts's `smallTalk`/`berry`, no
 * access to the Pixi-side `GardenCharm` instance living inside GardenScene's
 * effect) lives outside the garden scene; GardenScene subscribes and forwards
 * to `GardenCharm.forceChatter`/`forceBerry`.
 */

export type CharmSignal =
  | { type: 'chatter'; sessionId: string }
  | { type: 'berry'; sessionId: string };

type Listener = (signal: CharmSignal) => void;

const listeners = new Set<Listener>();

export function emitCharmSignal(signal: CharmSignal): void {
  for (const l of listeners) l(signal);
}

export function onCharmSignal(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
