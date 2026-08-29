import { useStore } from '@/store/store';
import type { LiveBattler, Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { speciesEntry } from '@/scene/garden/dexData';

interface Props {
  battler: LiveBattler;
  parent: Session;
  /** Fired unconditionally after the navigation logic below, regardless of
   *  whether that logic actually had to select/switch anything — lets a
   *  caller with its own state to unwind on navigation (SessionsOverview's
   *  overlay, closed via `setOpen(false)`) do so even when the guard below
   *  short-circuits because we're already on the parent in terminal view.
   *  RosterStrip/FocusSidebar don't pass one; omitting it changes nothing
   *  for them. */
  onNavigate?: () => void;
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
export function SubagentRosterCard({ battler, parent, onNavigate }: Props): JSX.Element {
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);

  const onClick = (): void => {
    const { selectedId, viewMode } = useStore.getState();
    // Now live from both FocusSidebar and SessionsOverview (both render in
    // 'terminal' view mode) — a click there while already on the parent
    // should still be a real no-op rather than an unnecessary re-select, so
    // the guard stays even though it's no longer just future-proofing.
    if (selectedId !== parent.id || viewMode !== 'terminal') {
      select(parent.id);
      setViewMode('terminal');
    }
    onNavigate?.();
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
