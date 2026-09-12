import { useEffect, useRef, useState } from 'react';
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
 *
 * Restyled (docs/arceus-v2-plan.md §3.7) to match the user-approved mockup's
 * `.overlay`/`.modal`/`.option` treatment — kicker label, radio-style option
 * cards, hint footer, the real `--arceus-gold`/`--arceus-ground` tokens.
 * `ask.options` are still plain free-text strings (the underlying
 * `poke-ask` tool call/schema is out of scope here — see main/pokeTools.ts),
 * not a structured title/description pair; `splitOption` below is a
 * best-effort visual split on Arceus's own " — " phrasing convention (see
 * `ARCEUS_SYSTEM_PROMPT_TEMPLATE`'s "mention what it was last working on"
 * instruction), degrading gracefully to a plain title when that pattern
 * isn't present.
 */

/** Best-effort title/description split on the first " — " — matches how
 *  Arceus's own persona is instructed to phrase an option (e.g. "continue
 *  with Chikorita — last task: '...' · idle 12m"). Falls back to the whole
 *  string as the title when no such separator is present, rather than
 *  guessing further at freeform model output. */
function splitOption(option: string): [string, string | undefined] {
  const sep = ' — ';
  const i = option.indexOf(sep);
  if (i === -1) return [option, undefined];
  return [option.slice(0, i), option.slice(i + sep.length)];
}

export function PokeAskModal(): JSX.Element | null {
  const ask = useStore((s) => s.pokeAsk);
  const setPokeAsk = useStore((s) => s.setPokeAsk);
  // Transient "chosen" highlight (mirrors the mockup's own brief flash
  // before the modal closes) — purely cosmetic; the real answer is written
  // to Arceus's pty as soon as this settles, below. `chosen !== null` also
  // doubles as "an answer is already in flight" — see `dismiss`/
  // `useEscapeToClose` below, which both need to stop firing once it is.
  const [chosen, setChosen] = useState<string | null>(null);
  // The `answer()` deferral timer (advisor fix: a race between choosing an
  // option and dismissing within the 250ms window could previously send
  // Arceus BOTH outcomes for the same question, with `setPokeAsk(null)`
  // running twice) — cleared on unmount and on every new `ask` so a stale
  // timer from a question that's already gone can never fire against the
  // next one.
  const pendingAnswerTimer = useRef<number | null>(null);

  // Hall-of-Origin HUD exchange strip (docs/arceus-v2-plan.md §3.7) — logs
  // the question itself the moment a new poke-ask actually appears (not on
  // every render), same real-not-fabricated log ArceusDispatchBox.tsx
  // writes into on send.
  useEffect(() => {
    if (ask) useStore.getState().pushArceusExchange({ who: 'arceus', text: ask.question });
    setChosen(null);
    return () => {
      if (pendingAnswerTimer.current !== null) {
        window.clearTimeout(pendingAnswerTimer.current);
        pendingAnswerTimer.current = null;
      }
    };
  }, [ask]);

  // Advisor fix: guarded on `ask !== null` (same as every other dialog in
  // this codebase — an always-armed listener would fire Escape into this
  // handler even while no picker is showing) AND on `chosen === null` — once
  // an option has been chosen, an answer is already in flight (see `answer`
  // below) and a dismiss (Escape/backdrop/button) landing in the same
  // 250ms window must no longer fire a SECOND, contradictory outcome.
  const dismiss = (): void => {
    if (!ask || chosen !== null) return;
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

  useEscapeToClose(dismiss, ask !== null && chosen === null);

  if (!ask) return null;

  const answer = (option: string): void => {
    setChosen(option);
    pendingAnswerTimer.current = window.setTimeout(() => {
      pendingAnswerTimer.current = null;
      const message = `Arceus asked: "${ask.question}" — the user chose: "${option}"`;
      void window.api.writePty(ARCEUS_SESSION_ID, wrapBracketedPaste(message) + '\r');
      useStore.getState().pushArceusExchange({ who: 'you', text: option });
      setPokeAsk(null);
    }, 250);
  };

  return (
    <div className="poke-ask-overlay" onClick={dismiss}>
      <div className="poke-ask-modal" onClick={(e) => e.stopPropagation()}>
        <div className="poke-ask-kicker">poke-ask</div>
        <h3>arceus is asking</h3>
        <p className="poke-ask-sub">{ask.question}</p>
        <div className="poke-ask-options">
          {ask.options.map((option) => {
            const [title, desc] = splitOption(option);
            const isChosen = chosen === option;
            return (
              <button
                key={option}
                type="button"
                className={isChosen ? 'poke-ask-option poke-ask-option-chosen' : 'poke-ask-option'}
                onClick={() => answer(option)}
                disabled={chosen !== null}
              >
                <span className="poke-ask-radio" aria-hidden="true" />
                <span className="poke-ask-option-body">
                  <span className="poke-ask-option-title">{title}</span>
                  {desc && <span className="poke-ask-option-desc">{desc}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="poke-ask-foot">
          <span className="poke-ask-hint">pick one — this pauses until you do</span>
          <button type="button" className="poke-ask-dismiss" onClick={dismiss} disabled={chosen !== null}>
            dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
