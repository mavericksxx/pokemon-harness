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

  // Advisor fix: guarded on `ask !== null`, same as every other dialog in
  // this codebase — an always-armed listener would fire Escape into this
  // handler even while no picker is showing.
  const dismiss = (): void => {
    if (!ask) return;
    // Advisor follow-up: his persona tells him to wait for a follow-up
    // message once poke-ask is accepted — without this, dismissing (Escape,
    // backdrop click, or the button below) leaves him waiting forever with
    // no signal his question was dropped.
    void window.api.writePty(
      ARCEUS_SESSION_ID,
      wrapBracketedPaste(`poke-ask outcome: the user dismissed the question ("${ask.question}") without answering.`) +
        '\r'
    );
    setPokeAsk(null);
  };

  useEscapeToClose(dismiss, ask !== null);

  if (!ask) return null;

  const answer = (option: string): void => {
    const message = `Arceus asked: "${ask.question}" — the user chose: "${option}"`;
    void window.api.writePty(ARCEUS_SESSION_ID, wrapBracketedPaste(message) + '\r');
    setPokeAsk(null);
  };

  return (
    <div className="modal-backdrop" onClick={dismiss}>
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
          <button type="button" onClick={dismiss}>
            dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
