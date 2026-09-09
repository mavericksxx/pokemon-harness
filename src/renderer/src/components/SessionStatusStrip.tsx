import type { CSSProperties } from 'react';
import { useStore } from '@/store/store';
import type { Session } from '@/store/store';
import { ModelBadge } from '@/components/ModelBadge';
import { formatContextCompact } from '@/components/CostGauge';
import { gaugeTone } from '@/design/gaugeTone';
import { stopSession } from '@/sessions';
import { sessionStatusLabel } from '@/design/sessionLabel';

interface Props {
  session: Session;
}

/**
 * Bottom statusline (session-status feature, design direction 5 "composite")
 * — a slim, always-visible row below the terminal reproducing the shape of
 * the CLI's own statusline (status · model · context · multitask) now that
 * the app silences it (hookBridge.ts's `prepareSession` swaps the CLI's
 * `statusLine` command for a no-op). No rate-limit windows here by design —
 * those live one click away in the trainer-card popover (TrainerCard.tsx)
 * instead.
 *
 * Mounted once in FocusView.tsx, directly under `.terminal-mount-wrap` —
 * that's the SAME render path for both the focus/'terminal' view mode's
 * terminal panel AND the garden/gardenFull drawer's terminal panel (see
 * FocusView's own header comment on why TerminalDrawer never swaps this
 * component out), so this one mount point covers both surfaces the approved
 * design calls for without any view-mode branching here.
 *
 * Also absorbs what used to be FocusView's own `.drawer-meta` row (status
 * chip + cwd + kill) and FocusTerminalHead's live indicator — one statusline
 * instead of four stacked chrome rows.
 *
 * Renders UNCONDITIONALLY at a fixed 24px height (see `.status-strip` in
 * index.css) — only the model badge and context gauge are gated on
 * `session.cost` (costWatcher.ts hasn't parsed a transcript line yet). This
 * used to return `null` outright until `cost` existed, but that made the
 * strip pop in and resize `.terminal-mount-wrap` the moment cost first
 * arrived, which fires `fit.fit()` + `resizePty` (terminalRegistry.ts) and
 * makes the CLI redraw mid-session. A fixed-height row never reflows.
 */
export function SessionStatusStrip({ session }: Props): JSX.Element {
  // Multitask ⇶ — the best live signal available (BACKLOG grounding doc):
  // hook payloads never carry subagent completion, so this counts currently
  // LIVE battlers this session spawned (battle system's own materialize/
  // cleanup events) rather than a true task-queue count. A plain `.length`
  // selector keeps this event-driven — no polling, and Zustand's default
  // equality only re-renders the strip when THIS session's count changes.
  const runningCount = useStore((s) => s.battlers.filter((b) => b.parentId === session.id).length);
  const cost = session.cost;

  let contextPct = 0;
  let tone = gaugeTone(0);
  if (cost) {
    contextPct = Math.round(Math.min(1, cost.contextTokens / cost.contextWindow) * 100);
    tone = gaugeTone(contextPct);
  }

  return (
    <div className="status-strip">
      <span className={session.napping ? 'status napping' : `status ${session.status}`}>
        {sessionStatusLabel(session)}
      </span>
      <span className="status-strip-divider">·</span>
      {cost && (
        <>
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
              <div
                className={`hp-bar-fill${tone !== 'normal' ? ` ${tone}` : ''}`}
                style={{ '--fill': contextPct / 100 } as CSSProperties}
              />
            </div>
            <span className="status-strip-ctx-num">
              {contextPct}% {formatContextCompact(cost.contextTokens)}/{formatContextCompact(cost.contextWindow)}
            </span>
          </span>
          <span className="status-strip-divider">·</span>
        </>
      )}
      <span className={runningCount > 0 ? 'multitask-glyph on' : 'multitask-glyph off'}>
        {runningCount > 0 ? `⇶ ${runningCount} running` : '⇶ idle'}
      </span>
      <span className="status-strip-path" title={session.cwd}>
        {session.cwd}
      </span>
      <button className="danger status-strip-kill" onClick={() => void stopSession(session.id)}>
        kill
      </button>
    </div>
  );
}
