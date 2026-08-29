/** Model badge label formatting (session-status feature) — shared by
 *  SessionStatusStrip.tsx, AgentRosterCard.tsx, and TrainerCard.tsx so the
 *  three surfaces never render the same raw model id three different ways.
 *
 *  "claude-sonnet-5-20250929" → "sonnet 5"; "claude-haiku-4-5-20251015" →
 *  "haiku 4.5"; "claude-fable-5-…" → "fable 5" — strips the "claude-" prefix
 *  every current model id carries (see costWatcher.ts's PRICE_TABLE/
 *  CONTEXT_WINDOW_TABLE) and any trailing dated snapshot suffix, then joins
 *  the remaining version segments with a dot (how these names read in
 *  prose). A non-claude or unrecognized model id falls through past the
 *  prefix strip unchanged — still readable, just not re-punctuated. */
export function modelDisplayLabel(model: string): string {
  const stripped = model.startsWith('claude-') ? model.slice('claude-'.length) : model;
  const parts = stripped.split('-').filter(Boolean);
  while (parts.length > 1 && /^\d{6,}$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.length === 0) return model;
  const [family, ...version] = parts;
  return version.length > 0 ? `${family} ${version.join('.')}` : family;
}

/** Whether a raw model id is the "Fable" promotional model — gold-borders
 *  the badge, same detection usageService.ts's own `7d fable` window label
 *  already relies on (its `scope.model.display_name` check, lowercased). */
export function isFableModel(model: string): boolean {
  return model.toLowerCase().includes('fable');
}
