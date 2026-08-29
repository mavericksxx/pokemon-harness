import { modelDisplayLabel, isFableModel } from '@/design/modelLabel';

interface Props {
  /** Raw model id off `SessionCostUpdate.model` (e.g. "claude-sonnet-5-…"). */
  model: string;
  /** Session's `modelChangedFrom` (shared/types.ts) — presence alone means
   *  "show the tick"; terminalRegistry.ts owns setting/clearing it per the
   *  "persists until next change" spec. */
  changedFrom?: string;
}

/** Model badge + "↺ changed from <prev>" tick (session-status feature) —
 *  shared between the statusline strip (SessionStatusStrip.tsx), the roster
 *  card (AgentRosterCard.tsx), and the trainer-card popover (TrainerCard.tsx)
 *  so the three surfaces never drift on label formatting or the fable
 *  gold-border treatment. Renders as sibling elements, not a wrapping span,
 *  so each caller lays them out inside its own flex row alongside its own
 *  dividers/other badges. */
export function ModelBadge({ model, changedFrom }: Props): JSX.Element {
  const fable = isFableModel(model);
  return (
    <>
      <span className={fable ? 'model-badge model-badge-fable' : 'model-badge'}>{modelDisplayLabel(model)}</span>
      {changedFrom && <span className="model-changed-tick">↺ changed from {modelDisplayLabel(changedFrom)}</span>}
    </>
  );
}
