import { useStore } from '@/store/store';
import type { Session } from '@/store/store';
import { ModelBadge } from '@/components/ModelBadge';
import { formatContextCompact } from '@/components/CostGauge';
import { gaugeTone } from '@/design/gaugeTone';

interface Props {
  session: Session;
}

/**
 * Statusline strip (session-status feature, design direction 5 "composite")
 * — a slim, always-visible row reproducing the shape of the CLI's own
 * statusline (model · context · multitask) now that the app silences it
 * (hookBridge.ts's `prepareSession` swaps the CLI's `statusLine` command for
 * a no-op). No rate-limit windows here by design — those live one click away
 * in the trainer-card popover (TrainerCard.tsx) instead.
 *
 * Mounted once in FocusView.tsx, directly under FocusTerminalHead — that's
 * the SAME render path for both the focus/'terminal' view mode's terminal
 * panel AND the garden/gardenFull drawer's terminal panel (see FocusView's
 * own header comment on why TerminalDrawer never swaps this component out),
 * so this one mount point covers both surfaces the approved design calls
 * for without any view-mode branching here.
 *
 * Renders nothing until costWatcher.ts has parsed at least one transcript
 * line for this session (`session.cost` undefined) — same "don't render"
 * gate CostGauge.tsx/AgentRosterCard.tsx already use for non-claude or
 * not-yet-parsed sessions.
 */
export function SessionStatusStrip({ session }: Props): JSX.Element | null {
  // Multitask ⇶ — the best live signal available (BACKLOG grounding doc):
  // hook payloads never carry subagent completion, so this counts currently
  // LIVE battlers this session spawned (battle system's own materialize/
  // cleanup events) rather than a true task-queue count. A plain `.length`
  // selector keeps this event-driven — no polling, and Zustand's default
  // equality only re-renders the strip when THIS session's count changes.
  const runningCount = useStore((s) => s.battlers.filter((b) => b.parentId === session.id).length);
  const cost = session.cost;
  if (!cost) return null;

  const contextPct = Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100);
  const tone = gaugeTone(contextPct);

  return (
    <div className="status-strip">
      {cost.model && (
        <>
          <span className="status-strip-seg">
            <ModelBadge model={cost.model} changedFrom={session.modelChangedFrom} />
          </span>
          <span className="status-strip-divider">·</span>
        </>
      )}
      <span className="status-strip-seg">
        context
        <div className="hp-bar">
          <div className={`hp-bar-fill${tone !== 'normal' ? ` ${tone}` : ''}`} style={{ width: `${contextPct}%` }} />
        </div>
        <span className="status-strip-ctx-num">
          {contextPct}% {formatContextCompact(cost.contextTokens)}/{formatContextCompact(cost.contextWindow)}
        </span>
      </span>
      <span className="status-strip-divider">·</span>
      <span className={runningCount > 0 ? 'multitask-glyph on' : 'multitask-glyph off'}>
        {runningCount > 0 ? `⇶ ${runningCount} running` : '⇶ idle'}
      </span>
    </div>
  );
}
