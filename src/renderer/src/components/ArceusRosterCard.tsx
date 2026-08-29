import { useStore } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { arceusIsLive, autoSummonArceus, selectArceus } from '@/arceus';
import { ARCEUS_DEX_ID, ARCEUS_SESSION_ID, ARCEUS_TITLE } from '@shared/arceus';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { StarIcon } from '@/components/icons';
import { gaugeTone } from '@/design/gaugeTone';

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
 *
 * Garden-split roster-strip rework — Arceus only ever renders here (neither
 * FocusSidebar nor SessionsOverview render him at all, both filter him out
 * of their own session lists), so unlike AgentRosterCard/SubagentRosterCard
 * there's no 'full' size to preserve elsewhere: this card IS the compact
 * ceremonial card now, permanently, no variant prop needed. Sized ~1.3× an
 * ordinary compact card (`.roster-card-wrap-arceus`, index.css) — narrower
 * than the old shipped 220px card, but still wider than a plain session so
 * the gold frame reads as ceremonial, not cramped.
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

  const classes = ['roster-card', 'roster-card-arceus', 'roster-card-compact', selected && 'selected']
    .filter(Boolean)
    .join(' ');

  // Same context sliver an ordinary compact card shows — Arceus is a real
  // claude session under the hood, so `session.cost` populates the same way.
  // Always rendered (0% width when there's no cost yet, e.g. never summoned)
  // rather than conditionally mounted, matching the compact-card discipline
  // elsewhere in this strip: a fixed shape means the strip's shared band
  // height never has to account for a shorter Arceus card.
  const cost = session?.cost;
  const contextPct = cost ? Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100) : 0;
  const contextTone = gaugeTone(contextPct);

  return (
    <div className="roster-card-wrap roster-card-wrap-arceus">
      <button
        type="button"
        className={classes}
        onClick={onClick}
        title={live && session ? `select arceus — ${sessionStatusLabel(session)}` : 'summon arceus'}
      >
        <div className="roster-card-top-compact">
          <span className="roster-card-face">
            <PokemonFace name={ARCEUS_DEX_ID} box={18} />
          </span>
          <span className="roster-card-title-compact">
            {/* Ceremonial-plaque star (parity sweep item 6) — beside the
                name, not on the sprite/frame, so it reads as part of his
                title rather than another badge competing with the shiny
                star or trainer-card corner trigger. */}
            <StarIcon className="roster-card-arceus-star" aria-hidden="true" />
            {ARCEUS_TITLE.toLowerCase()}
          </span>
          {live && session && (
            <span
              className={session.napping ? 'roster-card-dot napping' : `roster-card-dot ${session.status}`}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="hp-bar roster-card-ctx-sliver">
          <div
            className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
            style={{ width: `${contextPct}%` }}
          />
        </div>
      </button>
    </div>
  );
}
