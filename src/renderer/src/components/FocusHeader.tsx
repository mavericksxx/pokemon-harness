import type { Session } from '@/store/store';
import { PokemonFace } from '@/components/PokemonFace';
import { LoopIcon, TerminalIcon } from '@/components/icons';
import { speciesEntry } from '@/scene/garden/dexData';
import { AGENT_PROVIDERS } from '@shared/agentProvider';
import { sessionStatusLabel } from '@/design/sessionLabel';
import { stopSession } from '@/sessions';

interface Props {
  session: Session;
}

/** BACKLOG phase E — 'terminal' view mode's command center: one compact
 *  identity row above the terminal for the SELECTED session (face, title,
 *  species, provider, status badge, kill button). Deliberately the SAME
 *  fields telemetry AgentRosterCard.tsx already shows (no new telemetry, per
 *  the decided spec) — the `.status` badge markup is shared with that card
 *  rather than re-derived here. Renders for Arceus too (his session record
 *  has every field this needs); only his own dispatch box below the terminal
 *  is Arceus-only — see FocusView.tsx.
 *
 *  Munder Difflin restyle (backlog item): same fields/data as before, laid
 *  out to match the inspo's command-center header — a bordered avatar tile,
 *  the title in large pixel caps with the status chip riding next to it on
 *  the same line, and the species/provider line demoted to a muted subtitle
 *  underneath. `.focus-header-face` (unchanged class/markup, including the
 *  shiny badge) just grows a bordered square via CSS now — see index.css.
 *
 *  The header used to also render a `CostGauge` sliver next to the status
 *  chip (`.focus-header-gauge`) — a second, unlabeled copy of the exact same
 *  `session.cost.contextTokens`/`contextWindow` numbers SessionStatusStrip's
 *  labeled "context" bar already shows directly below this header
 *  (FocusView.tsx mounts both). Pure duplication, so it's gone; that slot now
 *  holds this header's own kill button — same `stopSession` call as the
 *  garden/split view's drawer-meta "kill" button (FocusView.tsx, non-focus
 *  branch), which is itself a bare, unconfirmed action, so this mirrors that
 *  (no confirmation dialog exists to mirror). */
export function FocusHeader({ session }: Props): JSX.Element {
  const providerLabel = AGENT_PROVIDERS[session.provider]?.label ?? session.provider;
  const species = session.isPlainTerminal
    ? 'terminal'
    : (speciesEntry(session.pokemon)?.name ?? session.pokemon).toLowerCase();

  return (
    <div className="focus-header" title={`${session.command} — ${session.cwd}`}>
      <span className="focus-header-face">
        {session.isPlainTerminal ? (
          <span className="terminal-session-icon terminal-session-icon-header">
            <TerminalIcon />
          </span>
        ) : (
          <PokemonFace name={session.pokemon} shiny={session.shiny} box={32} />
        )}
        {!session.isPlainTerminal && session.shiny && (
          <span className="shiny-badge" title="shiny" aria-label="shiny">
            ★
          </span>
        )}
      </span>
      <span className="focus-header-id">
        <span className="focus-header-title-row">
          <span className="focus-header-title">{session.title}</span>
          <em className={session.napping ? 'status napping' : `status ${session.status}`}>
            {session.looping ? (
              <>
                <LoopIcon className="status-loop-icon" /> looping
              </>
            ) : (
              sessionStatusLabel(session)
            )}
          </em>
        </span>
        <span className="focus-header-meta">
          {species} · {providerLabel}
        </span>
      </span>
      <button
        type="button"
        className="icon tip danger focus-header-kill"
        data-tip="kill session"
        onClick={() => void stopSession(session.id)}
      >
        ×
      </button>
    </div>
  );
}
