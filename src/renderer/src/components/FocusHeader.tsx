import type { Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { CostGauge } from '@/components/CostGauge';
import { LoopIcon } from '@/components/icons';
import { speciesEntry } from '@/scene/garden/dexData';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';

interface Props {
  session: Session;
}

/** BACKLOG phase E — 'terminal' view mode's command center: one compact
 *  identity row above the terminal for the SELECTED session (face, title,
 *  species, provider, status badge, cost/context gauge). Deliberately the
 *  SAME fields and same telemetry AgentRosterCard.tsx already shows (no new
 *  telemetry, per the decided spec) — CostGauge.tsx and the `.status` badge
 *  markup are shared with that card rather than re-derived here. Renders for
 *  Arceus too (his session record has every field this needs); only
 *  FocusComposer hides for him — see FocusView.tsx. */
export function FocusHeader({ session }: Props): JSX.Element {
  const providerLabel = AGENT_PROVIDERS[session.provider]?.label ?? session.provider;
  const species = (speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase();

  return (
    <div className="focus-header" title={`${session.command} — ${session.cwd}`}>
      <span className="focus-header-face">
        <PokemonFace name={session.pokemon} shiny={session.shiny} box={32} />
        {session.shiny && (
          <span className="shiny-badge" title="shiny" aria-label="shiny">
            ★
          </span>
        )}
      </span>
      <span className="focus-header-id">
        <span className="focus-header-title">{session.title}</span>
        <span className="focus-header-meta">
          {species} · {providerLabel}
        </span>
      </span>
      <em className={session.napping ? 'status napping' : `status ${session.status}`}>
        {session.looping ? (
          <>
            <LoopIcon className="status-loop-icon" /> looping
          </>
        ) : (
          sessionStatusLabel(session)
        )}
      </em>
      {session.cost && <CostGauge cost={session.cost} className="focus-header-gauge" />}
    </div>
  );
}
