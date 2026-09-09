import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { arceusIsLive, autoSummonArceus, selectArceus } from '@/arceus';
import { ARCEUS_DEX_ID, ARCEUS_SESSION_ID, ARCEUS_TITLE } from '@shared/arceus';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { LoopIcon, StarIcon } from '@/components/icons';
import { gaugeTone } from '@/design/gaugeTone';
import { ModelBadge } from '@/components/ModelBadge';
import { formatContextCompact } from '@/components/CostGauge';
import { SummonArceusDialog } from '@/components/SummonArceusDialog';

interface Props {
  /** The rail expands the selected card in place. Arceus uses the same
   *  compact/medium states as an ordinary session, with his medium state
   *  carrying the live status/model/context/cost HUD. */
  variant?: 'compact' | 'medium';
  /** 'terminal' view mode has no garden pane of its own drawing his cosmic
   *  ascent, so RosterStrip.tsx forces `variant="medium"` there regardless
   *  of selection — this flag layers a little extra weight on top (heavier
   *  gold edge, more breathing room) so that forced-medium state still
   *  reads as a distinct, ceremonial entry rather than just another agent
   *  card that happens to be expanded. Reuses the existing Arceus tokens
   *  (`--arceus-gold*`) rather than inventing a second look. */
  ceremonial?: boolean;
}

/**
 * Arceus's own permanent card in the party rail (RosterStrip.tsx) — unlike
 * every ordinary `AgentRosterCard`, this one isn't backed by a session that
 * may or may not exist: it renders unconditionally, pinned first ahead of
 * the filtered session list, so the god of the garden is always visible,
 * even in a workspace with no sessions at all. A gold frame (`.roster-card-
 * arceus`, index.css) is the only thing that marks it as different from an
 * ordinary card — everything else (face, name, selected ring) matches.
 *
 * Now that the rail guarantees an Arceus card in EVERY view mode, this card
 * carries his FULL summon flow itself (SummonArceusButton, formerly the
 * topbar's one home for it, is retired): live selects him; not live tries
 * the silent auto-summon from saved config, opening `SummonArceusDialog` on
 * a genuine first run (`'no-config'`) and pushing the existing "couldn't
 * return" toast on `'failed'`.
 *
 * Garden-split roster-strip rework — Arceus only ever renders here
 * (SessionsOverview still filters him out of its own session list), so
 * there is no 'full' size to preserve. The rail supplies the same
 * compact/medium selection states as an ordinary session. Sized ~1.3× an
 * ordinary compact card when unselected, and the ordinary medium width when
 * selected (or forced via `ceremonial`) so his telemetry has room to
 * breathe.
 */
export function ArceusRosterCard({ variant = 'compact', ceremonial = false }: Props): JSX.Element {
  const session = useStore((s) => s.sessions.find((x) => x.id === ARCEUS_SESSION_ID));
  const live = !!session && session.status !== 'done';
  const selected = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  const pushToast = useStore((s) => s.pushToast);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [summoning, setSummoning] = useState(false);

  const onClick = async (): Promise<void> => {
    if (arceusIsLive()) {
      selectArceus();
      return;
    }
    if (summoning) return;
    setSummoning(true);
    const outcome = await autoSummonArceus();
    setSummoning(false);
    if (outcome === 'no-config') setDialogOpen(true);
    else if (outcome === 'failed') pushToast("arceus couldn't return — click his card to re-summon.");
  };

  const classes = [
    'roster-card',
    'roster-card-arceus',
    `roster-card-${variant}`,
    ceremonial && 'roster-card-arceus-ceremonial',
    selected && 'selected'
  ]
    .filter(Boolean)
    .join(' ');

  // The rail gives every card the same full row width regardless of
  // compact/medium (unlike the old horizontal strip, where those variants
  // also meant different WIDTHS) — no wrap modifier class needed here
  // beyond the plain shared one.
  const wrapClasses = 'roster-card-wrap';

  // Same context sliver an ordinary compact card shows — Arceus is a real
  // claude session under the hood, so `session.cost` populates the same way.
  // Always rendered (0% width when there's no cost yet, e.g. never summoned)
  // rather than conditionally mounted, matching the compact-card discipline
  // elsewhere in this strip: a fixed shape means the strip's shared band
  // height never has to account for a shorter Arceus card.
  const cost = session?.cost;
  const contextPct = cost ? Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100) : 0;
  const contextTone = gaugeTone(contextPct);
  const model = cost?.model ?? session?.model;
  const providerShortLabel = session ? (AGENT_PROVIDERS[session.provider]?.shortLabel ?? session.provider) : 'claude';
  const statusClass = session ? (session.napping ? 'napping' : session.status) : 'starting';
  const contextTip = cost
    ? `${formatContextCompact(cost.contextTokens)} / ${formatContextCompact(cost.contextWindow)} context (approx.) · $${cost.costUsd.toFixed(2)}`
    : 'context unavailable until the session reports usage';

  return (
    <div className={wrapClasses}>
      <button
        type="button"
        className={classes}
        onClick={() => void onClick()}
        disabled={summoning}
        title={
          live && session
            ? `select arceus — ${sessionStatusLabel(session)}`
            : summoning
              ? 'summoning…'
              : 'summon arceus'
        }
      >
        <span className="roster-card-arceus-cosmic" aria-hidden="true">
          <span className="roster-card-arceus-pixels" />
          <span className="roster-card-arceus-glint" />
          <span className="roster-card-arceus-wheel" />
          <span className="roster-card-arceus-corner roster-card-arceus-corner-tl" />
          <span className="roster-card-arceus-corner roster-card-arceus-corner-tr" />
          <span className="roster-card-arceus-corner roster-card-arceus-corner-bl" />
          <span className="roster-card-arceus-corner roster-card-arceus-corner-br" />
          <span className="roster-card-arceus-rail roster-card-arceus-rail-top" />
          <span className="roster-card-arceus-rail roster-card-arceus-rail-bottom" />
        </span>
        <div className="roster-card-top-compact">
          <span className="roster-card-face">
            <PokemonFace name={ARCEUS_DEX_ID} box={variant === 'medium' ? 32 : 18} />
          </span>
          <span className="roster-card-title-compact">
            {/* The existing star is the compact crest and medium title mark;
                the frame carries the rest of the ceremonial treatment. */}
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

        {variant === 'compact' && (
          <div className="hp-bar roster-card-ctx-sliver">
            <div
              className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
              style={{ '--fill': contextPct / 100 } as CSSProperties}
            />
          </div>
        )}

        {variant === 'medium' && (
          <>
            <div className={session ? 'roster-card-arceus-status-row' : 'roster-card-arceus-status-row roster-card-row-hidden'}>
              {session ? (
                <em className={`status ${statusClass}`}>
                  {session.looping ? (
                    <>
                      <LoopIcon className="status-loop-icon" /> looping
                    </>
                  ) : (
                    sessionStatusLabel(session)
                  )}
                </em>
              ) : (
                <em className="status starting">awaiting summon</em>
              )}
              <span className="roster-card-arceus-provider">{providerShortLabel}</span>
            </div>

            <div className="roster-card-arceus-model-row">
              {model ? (
                <ModelBadge model={model} changedFrom={session?.modelChangedFrom} />
              ) : (
                <span className="model-badge roster-card-row-hidden">&nbsp;</span>
              )}
              <span className={cost ? 'roster-card-arceus-cost' : 'roster-card-arceus-cost roster-card-row-hidden'}>
                {cost ? `$${cost.costUsd.toFixed(2)}` : ' '}
              </span>
            </div>

            <div
              className={cost ? 'roster-card-arceus-context-row' : 'roster-card-arceus-context-row roster-card-row-hidden'}
              title={contextTip}
            >
              <span className="roster-card-ctx-label">context</span>
              <div className="hp-bar roster-card-ctx-sliver-md">
                <div
                  className={`hp-bar-fill${cost && contextTone !== 'normal' ? ` ${contextTone}` : ''}`}
                  style={{ '--fill': (cost ? contextPct : 0) / 100 } as CSSProperties}
                />
              </div>
              <span className="roster-card-ctx-label">{cost ? `${contextPct}%` : ' '}</span>
            </div>
          </>
        )}
      </button>
      {dialogOpen && <SummonArceusDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}
