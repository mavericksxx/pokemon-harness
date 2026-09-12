import { useStore } from '@/store/store';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { wrapBracketedPaste } from '@/arceus';
import { useEscapeToClose } from './useEscapeToClose';

/**
 * Arceus v2 (docs/arceus-v2-plan.md §3.2/§7) — the `poke-ask` picker. Shown
 * while `useStore().pokeAsk` is non-null (set by main.tsx's `onPokeAsk`
 * listener, cleared here). Answering an option types the answer straight
 * into ARCEUS'S OWN pty (same `window.api.writePty` mechanism
 * ArceusDispatchBox.tsx already uses) — this is the whole "async round trip"
 * `poke-ask` resolves to (plan §3.2): Arceus's own tool call already
 * returned immediately; this is what starts his NEXT turn once the user has
 * actually answered.
 */
export function PokeAskModal(): JSX.Element | null {
  const ask = useStore((s) => s.pokeAsk);
  const setPokeAsk = useStore((s) => s.setPokeAsk);

  useEscapeToClose(() => setPokeAsk(null));

  if (!ask) return null;

  const answer = (option: string): void => {
    const message = `Arceus asked: "${ask.question}" — the user chose: "${option}"`;
    void window.api.writePty(ARCEUS_SESSION_ID, wrapBracketedPaste(message) + '\r');
    setPokeAsk(null);
  };

  return (
    <div className="modal-backdrop" onClick={() => setPokeAsk(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>arceus is asking</h2>
        <p className="hint">{ask.question}</p>
        <div className="poke-ask-options">
          {ask.options.map((option) => (
            <button key={option} type="button" onClick={() => answer(option)}>
              {option}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => setPokeAsk(null)}>
            dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
