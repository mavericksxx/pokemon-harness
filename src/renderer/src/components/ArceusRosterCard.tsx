import { useStore } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { arceusIsLive, autoSummonArceus, selectArceus } from '@/arceus';
import { ARCEUS_DEX_ID, ARCEUS_SESSION_ID, ARCEUS_TITLE } from '@shared/arceus';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { StarIcon } from '@/components/icons';

/**
 * Arceus's own permanent card in the bottom roster strip — unlike every
 * ordinary `AgentRosterCard`, this one isn't backed by a session that may or
 * may not exist: it renders unconditionally (RosterStrip prepends it ahead
 * of the filtered session list), so the god of the garden is always visible,
 * even in a workspace with no sessions at all. A gold frame (`.roster-card-
 * arceus`, index.css) is the only thing that marks it as different from an
 * ordinary card — everything else (face, name, selected ring) matches.
 *
 * Click behavior deliberately mirrors `SummonArceusButton`'s core logic
 * (select if he's already live, otherwise try the silent auto-summon from
 * saved config) rather than duplicating its dialog/toast handling here too
 * — a first-ever summon (no saved config yet) still has exactly one home,
 * the topbar chip, so this card doesn't open a second summon flow; it just
 * points the user at that chip via a toast (same toast mechanism
 * SummonArceusButton already uses for its own 'failed' outcome). That keeps
 * this card cheap and dumb, matching the "presentation only" ask.
 */
export function ArceusRosterCard(): JSX.Element {
  const session = useStore((s) => s.sessions.find((x) => x.id === ARCEUS_SESSION_ID));
  const live = !!session && session.status !== 'done';
  const selected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  const pushToast = useStore((s) => s.pushToast);

  const onClick = (): void => {
    if (arceusIsLive()) {
      selectArceus();
      return;
    }
    void autoSummonArceus().then((outcome) => {
      if (outcome === 'no-config') pushToast('arceus needs a one-time setup — click his chip in the topbar.');
      else if (outcome === 'failed') pushToast("arceus couldn't return — click his chip to re-summon.");
    });
  };

  const classes = ['roster-card', 'roster-card-arceus', selected && 'selected'].filter(Boolean).join(' ');

  return (
    <div className="roster-card-wrap">
      <button
        type="button"
        className={classes}
        onClick={onClick}
        title={live && session ? `select arceus — ${sessionStatusLabel(session)}` : 'summon arceus'}
      >
        <div className="roster-card-top">
          <span className="roster-card-face">
            <PokemonFace name={ARCEUS_DEX_ID} box={32} />
          </span>
          <span className="roster-card-id">
            <span className="roster-card-name">
              {/* Ceremonial-plaque star (parity sweep item 6) — beside the
                  name, not on the sprite/frame, so it reads as part of his
                  title rather than another badge competing with the shiny
                  star or trainer-card corner trigger. */}
              <StarIcon className="roster-card-arceus-star" aria-hidden="true" />
              {ARCEUS_TITLE.toLowerCase()}
            </span>
          </span>
          {live && session && (
            <span
              className={session.napping ? 'summon-arceus-dot napping' : `summon-arceus-dot ${session.status}`}
              aria-hidden="true"
            />
          )}
        </div>
      </button>
    </div>
  );
}
