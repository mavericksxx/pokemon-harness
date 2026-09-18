import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '@/store/store';
import type { LiveBattler, Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { PokeballIcon } from '@/components/icons';
import { speciesEntry } from '@/scene/garden/dexData';

/** Same local re-render tick TrainerCard.tsx's popover uses for its "resets
 *  in"/"as of" readouts — keeps the elapsed-time line below roughly live
 *  without a per-second re-render for every subagent card on screen. */
const ELAPSED_TICK_MS = 30_000;

interface Props {
  /** Exactly one of `battler`/`delegate` is set by the caller — a live
   *  subagent battler (RosterStrip/SessionsOverview) or a nested first-class
   *  delegate session (RosterStrip only, `delegateParentId`). Both render
   *  through this one component so a delegate's card is visually and
   *  behaviorally identical to a battler's — the roster shouldn't tell them
   *  apart just because one has its own live pty and the other doesn't. */
  battler?: LiveBattler;
  delegate?: Session;
  parent: Session;
  /** Fired unconditionally after the navigation calls in `onClick` below —
   *  lets a caller with its own state to unwind on navigation
   *  (SessionsOverview's overlay, closed via `setOpen(false)`) do so.
   *  RosterStrip doesn't pass one; omitting it changes nothing for it. */
  onNavigate?: () => void;
  /** Garden-split roster-strip rework, same size/variant idea as
   *  AgentRosterCard.tsx's own prop — SessionsOverview never passes this
   *  (default 'full', unchanged). RosterStrip.tsx (the party rail) always
   *  passes 'compact': sprite, task-label (or species) title, a "↳ parent" line,
   *  and a sliver — no working dot (a battler has exactly one status, so a
   *  dot would be pure noise at this size) and no inline elapsed time (moved
   *  into the button's own `title` tooltip instead, see below). A subagent
   *  never expands to 'medium' — it isn't independently selectable, clicking
   *  it selects its PARENT (see `onClick` below). */
  variant?: 'full' | 'compact';
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
 *  Also backs a first-class delegate session's nested card (RosterStrip.tsx
 *  only, `delegateParentId`) — a delegate used to render as a full-size
 *  `AgentRosterCard` there, which looked and behaved nothing like a Claude
 *  subagent's card despite being the same kind of thing ("this parent's
 *  child agent"). Passing `delegate` instead of `battler` gets the identical
 *  markup below with the delegate session's own species/title/status fed in
 *  (see the shared-fields block early in the function body); the one real
 *  behavioral difference is `onClick`, since a delegate — unlike a battler —
 *  has its own live pty and is selected directly rather than via its parent.
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
 *  on both "where its output is" and "where it physically is" at once.
 *
 *  Title line (parity sweep item 7 — investigated whether a real name/
 *  description exists for a battler at spawn time: it does, the spawning
 *  `Task`'s own `description`/`subagent_type`, see `LiveBattler.label`'s own
 *  comment) — when present, it's the title line here, species moved down
 *  alongside the parent line, mirroring AgentRosterCard's title-then-species
 *  layout instead of reading species-first like a session of its own. Falls
 *  back to species-as-title (this card's original layout) for the
 *  regex-fallback path, where no label exists.
 *
 *  Done/retired follow-up: a battler that lost its completion battle no
 *  longer poofs away — it stays on the strip, off-duty, until dismissed. A
 *  `done` battler shows a green status (compact: `.roster-card-dot.done`;
 *  full: the elapsed line freezes at "done — ran Xm" instead of continuing
 *  to climb) and a despawn button (both variants — icon-only in compact,
 *  same treatment AgentRosterCard's compact swap button already uses)
 *  that plays a pokéball-recall animation in the garden, then removes it
 *  for good. */
export function SubagentRosterCard({ battler, delegate, parent, onNavigate, variant = 'full' }: Props): JSX.Element {
  const select = useStore((s) => s.select);
  const setViewMode = useStore((s) => s.setViewMode);
  const setDrawerOpen = useStore((s) => s.setDrawerOpen);
  const setFocusBattlerKey = useStore((s) => s.setFocusBattlerKey);
  const requestDespawnBattler = useStore((s) => s.requestDespawnBattler);
  const requestRecallDelegate = useStore((s) => s.requestRecallDelegate);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Shared fields resolved off whichever of `battler`/`delegate` the caller
  // passed — everything below this point (and all the markup further down)
  // reads only these, never `battler`/`delegate` directly, so a delegate's
  // card renders through the exact same code path as a battler's.
  const species = battler ? battler.species : (delegate as Session).pokemon;
  const label = battler ? battler.label : (delegate as Session).title;
  const done = battler ? battler.done : (delegate as Session).status === 'done';
  const spawnedAt = battler ? battler.spawnedAt : (delegate as Session).createdAt;
  // A delegate session has no `doneAt` of its own — `statusChangedAt` (the
  // epoch ms it last entered its current `status`) is the same "when did
  // this go done" moment for a session as `doneAt` is for a battler.
  const doneAt = battler ? battler.doneAt : (delegate as Session).statusChangedAt;
  const relation = battler ? 'subagent' : 'delegate';

  const onClick = (): void => {
    if (battler) {
      select(parent.id);
      // 'garden' is the split layout (garden pane + terminal drawer side by
      // side, see gardenSplit.ts) — force the drawer open too, since 'garden'
      // mode alone leaves the terminal collapsed if the user last closed it.
      setViewMode('garden');
      setDrawerOpen(true);
      // Set AFTER select() — select() clears focusBattlerKey as a general
      // "new selection" safety net, so this has to land last to stick.
      setFocusBattlerKey(battler.key);
    } else {
      // Unlike a battler, a delegate has its own live pty/terminal — clicking
      // its card just selects IT, same as an ordinary top-level card, rather
      // than panning to a parent's garden view.
      select((delegate as Session).id);
    }
    onNavigate?.();
  };

  const speciesName = (speciesEntry(species)?.name ?? species).toLowerCase();

  // Frozen at `doneAt` once done (falls back to `now` for the brief window
  // before `doneAt` lands, same tick `done` itself does) — a done battler's
  // elapsed readout must stop climbing once the subagent has actually
  // finished, not keep counting the off-duty wandering time on top of it.
  const elapsedText = done
    ? `done — ran ${formatElapsed((doneAt ?? now) - spawnedAt)}`
    : `alive — running ${formatElapsed(now - spawnedAt)}`;
  const baseTitle = label
    ? `${label} — ${speciesName}, ${relation} of ${parent.title}`
    : `${speciesName} — ${relation} of ${parent.title}`;

  const onDespawn = (): void =>
    battler ? requestDespawnBattler(battler.key) : requestRecallDelegate((delegate as Session).id);

  return (
    <div className="roster-card-wrap">
      <button
        type="button"
        className={variant === 'compact' ? 'roster-card roster-card-subagent roster-card-compact' : 'roster-card roster-card-subagent'}
        onClick={onClick}
        // Compact strip card drops the visible "alive — running Xm" line
        // (item 5, garden-split rework: "keep the elapsed-time info as a
        // title-attribute tooltip if it doesn't fit visibly without
        // cramming") — folded into the tooltip instead so it's still one
        // hover away.
        title={variant === 'compact' ? `${baseTitle} — ${elapsedText}` : baseTitle}
      >
        {variant === 'compact' ? (
          <>
            <div className="roster-card-top-compact">
              <span className="roster-card-face">
                <PokemonFace name={species} box={18} />
              </span>
              <span className="roster-card-title-compact">{label || speciesName}</span>
              {/* Was omitted entirely pre-done-follow-up ("a battler has
                  exactly one status, so a dot would be pure noise") — now
                  there are two (alive/done), so the dot earns its keep. */}
              <span className={`roster-card-dot ${done ? 'done' : 'working'}`} aria-hidden="true" />
            </div>
            <div className="roster-card-parent-compact">↳ {parent.title}</div>
            {/* No real per-subagent telemetry exists to fill this (see the
                header comment above) — a full, steady 'working'-toned sliver
                is purely decorative here, matching the compact ordinary/
                Arceus cards' silhouette (sprite/title row + sliver) so the
                strip reads as one consistent row shape rather than singling
                this card out with a shorter box. */}
            <div className="hp-bar roster-card-ctx-sliver">
              <div className="hp-bar-fill" style={{ '--fill': 1 } as CSSProperties} />
            </div>
          </>
        ) : (
          <>
            <div className="roster-card-top">
              <span className="roster-card-face">
                <PokemonFace name={species} box={32} />
              </span>
              <span className="roster-card-id">
                {/* Session-card parity (item 7) — title line is the real name
                    when one exists (the spawning Task's own description), species
                    and parent folded into the second line together; falls back
                    to the original species-as-title layout when it doesn't. */}
                <span className="roster-card-name">{label || speciesName}</span>
                <span className="roster-card-species">
                  {label ? `${speciesName} · ↳ ${parent.title}` : `↳ ${parent.title} · ${relation}`}
                </span>
              </span>
              {/* Reusing `.summon-arceus-dot` — a standalone status-color dot,
                  no badge background/pill text, not a copy/paste of the wrong
                  class: a battler has exactly two statuses worth showing
                  (alive/done), so this tracks `done` rather than
                  `session.status`'s full state machine. */}
              <span className={`summon-arceus-dot ${done ? 'done' : 'working'}`} aria-hidden="true" />
            </div>
            <div className="roster-card-tool">{elapsedText}</div>
          </>
        )}
      </button>

      {/* Despawn action (done/retired follow-up) — offered only once the
          subagent is actually done; a live one just keeps working. Sibling
          of the card `<button>` above, same reasoning as AgentRosterCard's
          `.roster-card-swap` (a button can't nest another button). Recall
          animation plays in the garden (battleFx.ts's
          `spawnPokeballRecall`); the card disappears once BattleManager's
          `onBattlerRemoved` fires at the end of it. */}
      {done && (
        <button type="button" className="roster-card-despawn" title="despawn" onClick={onDespawn}>
          <PokeballIcon />
          despawn
        </button>
      )}
    </div>
  );
}
