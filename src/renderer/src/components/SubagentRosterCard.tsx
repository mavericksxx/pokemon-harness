import { useStore } from '@/store/store';
import type { LiveBattler, Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { speciesEntry } from '@/scene/garden/dexData';

interface Props {
  battler: LiveBattler;
  parent: Session;
}

/** A live subagent battler's own card in the roster strip (Phase 4 Part B
 *  follow-up — "subagent roster presence"). Same card shell/size as
 *  AgentRosterCard (RosterStrip.tsx renders it right after its parent's own
 *  card), content adapted for a battler: species face/name, a "working" dot
 *  (a battler has no richer status than "alive" — there's nothing else to
 *  show), and a "↳ parent" line so it reads as belonging to that session
 *  rather than as a session of its own.
 *
 *  Clicking navigates to the parent instead of selecting the battler itself
 *  (there's no session/terminal behind it) — select the parent session and
 *  drop into terminal view, the same two calls SessionsOverview.tsx's own
 *  `pick` makes, since that's where the CLI actually renders this
 *  subagent's progress rows. */
export function SubagentRosterCard({ battler, parent }: Props): JSX.Element {
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);

  const onClick = (): void => {
    const { selectedId, viewMode } = useStore.getState();
    // Dead from RosterStrip today (it only renders in 'garden' view mode,
    // never 'terminal'), but kept as a real no-op rather than assumed away —
    // this card's onClick isn't tied to any one caller, and a future surface
    // that renders it inside terminal view should get "already there" for
    // free rather than an unnecessary re-select.
    if (selectedId === parent.id && viewMode === 'terminal') return;
    select(parent.id);
    setViewMode('terminal');
  };

  const speciesName = (speciesEntry(battler.species)?.name ?? battler.species).toLowerCase();

  return (
    <div className="roster-card-wrap">
      <button
        type="button"
        className="roster-card roster-card-subagent"
        onClick={onClick}
        title={`${speciesName} — subagent of ${parent.title}`}
      >
        <div className="roster-card-top">
          <span className="roster-card-face">
            <PokemonFace name={battler.species} box={32} />
          </span>
          <span className="roster-card-id">
            <span className="roster-card-name">{speciesName}</span>
            <span className="roster-card-species">↳ {parent.title}</span>
          </span>
          {/* Reusing `.summon-arceus-dot` — the same standalone status-color
              dot ArceusRosterCard's topbar chip uses, not a copy/paste of the
              wrong class: a battler has exactly one status worth showing
              ("alive"), so it's hardcoded to the 'working' color rather than
              tracking `session.status`'s full state machine. */}
          <span className="summon-arceus-dot working" aria-hidden="true" />
        </div>
      </button>
    </div>
  );
}
