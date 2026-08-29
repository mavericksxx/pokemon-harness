import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import type { LiveBattler, Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { speciesEntry } from '@/scene/garden/dexData';

/** Same local re-render tick TrainerCard.tsx's popover uses for its "resets
 *  in"/"as of" readouts — keeps the elapsed-time line below roughly live
 *  without a per-second re-render for every subagent card on screen. */
const ELAPSED_TICK_MS = 30_000;

interface Props {
  battler: LiveBattler;
  parent: Session;
  /** Fired unconditionally after the navigation calls in `onClick` below —
   *  lets a caller with its own state to unwind on navigation
   *  (SessionsOverview's overlay, closed via `setOpen(false)`) do so.
   *  RosterStrip/FocusSidebar don't pass one; omitting it changes nothing
   *  for them. */
  onNavigate?: () => void;
}

/** Elapsed time since spawn, rounded to whole minutes ("<1m"/"3m"/"1h 4m") —
 *  matches the app's other duration readouts (usageFormat.ts's
 *  `formatResetIn`/`formatAgo`), which round to minutes rather than showing
 *  seconds-level precision no one needs here. */
function formatElapsed(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${totalMin % 60}m`;
}

/** A live subagent battler's own card in the roster strip (Phase 4 Part B
 *  follow-up — "subagent roster presence"). Same card shell/size as
 *  AgentRosterCard (RosterStrip.tsx renders it right after its parent's own
 *  card), content adapted for a battler: species face/name, a "working" dot
 *  (a battler has no richer status than "alive" — there's nothing else to
 *  show, so the line below spells that out in text too) and how long it's
 *  been running, and a "↳ parent" line so it reads as belonging to that
 *  session rather than as a session of its own.
 *
 *  Elapsed time, not context/tokens: per-subagent context telemetry doesn't
 *  exist (costWatcher.ts's cost:update is per harness session/pty — a
 *  subagent's own completion never reaches it), and showing the PARENT's
 *  context here would misleadingly read as the subagent's own. Elapsed time
 *  since spawn is the one real number available for a battler.
 *
 *  Clicking switches to the garden/terminal split view ('garden' viewMode —
 *  see gardenSplit.ts) with the PARENT selected (that's where this
 *  subagent's progress rows actually stream — it has no terminal of its
 *  own) and pans the garden camera onto the battler's own sprite
 *  (`focusBattlerKey`, consumed by GardenScene's ticker), so the click lands
 *  on both "where its output is" and "where it physically is" at once. */
export function SubagentRosterCard({ battler, parent, onNavigate }: Props): JSX.Element {
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const setFocusBattlerKey = useStore((s) => s.setFocusBattlerKey);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const onClick = (): void => {
    select(parent.id);
    // 'garden' is the split layout (garden pane + terminal drawer side by
    // side, see gardenSplit.ts) — force the drawer open too, since 'garden'
    // mode alone leaves the terminal collapsed if the user last closed it.
    setViewMode('garden');
    setDrawerOpen(true);
    // Set AFTER select() — select() clears focusBattlerKey as a general
    // "new selection" safety net, so this has to land last to stick.
    setFocusBattlerKey(battler.key);
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
        <div className="roster-card-tool">alive — running {formatElapsed(now - battler.spawnedAt)}</div>
      </button>
    </div>
  );
}
