import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { useStore } from '@/store/store';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { loadArceusSummonConfig, saveArceusSummonConfig, summonArceus } from '@/arceus';
import { composeArceusSummary, buildArceusBoardRows } from '@/arceusSummary';
import { ArceusDispatchBox } from '@/components/ArceusDispatchBox';
import { WARP_MS } from '@/components/ArceusWarp';

const ARCEUS_HUD_PROVIDERS: AgentProviderId[] = ['claude', 'codex'];

/**
 * The Hall of Origin's right-side HUD (docs/arceus-v2-plan.md §3.6/§3.7) —
 * translucent panels floating directly over the full-bleed cosmos (see
 * `.reference/hall-of-origin-mockup.html`'s `.hud-right`), not a separate
 * solid side panel. Top to bottom: the ambient summary card (one-liner +
 * show-details/refresh + the inline model-switch link, §3.8), the per-agent
 * board (hidden by default), the exchange strip, and Arceus's own dispatch
 * box pinned at the bottom.
 *
 * Always mounted (same "mounted always, visibility driven by `ascended`"
 * pattern ArceusWarp.tsx uses) so `detailsOpen`/the model panel/exchange
 * scroll position all survive flipping the warp back and forth — only its
 * OWN opacity/pointer-events toggle, on a short delay past `WARP_MS` so it
 * doesn't visibly overlap the warp transition itself.
 */
export function ArceusHud({ ascended }: { ascended: boolean }): JSX.Element {
  const [showHud, setShowHud] = useState(ascended);
  useEffect(() => {
    if (!ascended) {
      setShowHud(false);
      return;
    }
    const t = window.setTimeout(() => setShowHud(true), WARP_MS);
    return () => window.clearTimeout(t);
  }, [ascended]);

  const sessions = useStore((s) => s.sessions);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const exchange = useStore((s) => s.arceusExchange);
  const arceusSession = useStore((s) => s.sessions.find((x) => x.id === ARCEUS_SESSION_ID));

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // eslint no-op read — `refreshNonce` only exists to force `useMemo` below
  // to recompute against the CURRENT clock (idle/blocked durations keep
  // advancing even when nothing else about the session list has changed).
  const summary = useMemo(
    () => composeArceusSummary(sessions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, refreshNonce]
  );
  const rows = useMemo(() => buildArceusBoardRows(sessions, workspaces), [sessions, workspaces]);

  const exchangeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = exchangeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchange]);

  // ── inline provider/model switch (docs/arceus-v2-plan.md §3.8) ──────────
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState<AgentProviderId>('claude');
  const [modelDraft, setModelDraft] = useState('');
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Reseed the draft fields from Arceus's own live session record every
  // time the panel is opened — never while it's already open (a live
  // `cost:update`-driven `model` change mid-edit shouldn't yank the
  // in-progress draft out from under the user).
  const openModelPanel = (): void => {
    setProviderDraft(arceusSession?.provider ?? 'claude');
    setModelDraft(arceusSession?.model ?? '');
    setApplyError(null);
    setModelPanelOpen(true);
  };

  const modelLinkLabel = arceusSession
    ? `${arceusSession.provider} · ${arceusSession.model || 'default'} ✎`
    : 'arceus ✎';

  // Advisor fix: the dev stand-in (`POKE_ARCEUS_DEV_STANDIN`, arceus.ts's
  // `summonArceusDevStandin`) runs Arceus as a plain shell tagged `provider:
  // 'shell'` — outside `ARCEUS_HUD_PROVIDERS`'s claude/codex pair. Without
  // this guard the `<select>` would silently show no matching option, and
  // "apply" would call the REAL `summonArceus`, spawning an actual claude/
  // codex process — this app's own repo rule is that nothing here ever does
  // that for its own dev/testing. Hidden outright rather than disabled, same
  // as the link simply not existing for a not-yet-summoned Arceus.
  const showModelSwitch = !arceusSession || ARCEUS_HUD_PROVIDERS.includes(arceusSession.provider);

  const applyModelChange = async (): Promise<void> => {
    if (!arceusSession) return;
    const newProvider = providerDraft;
    const newModel = modelDraft.trim() || undefined;
    const unchanged = newProvider === arceusSession.provider && (newModel ?? '') === (arceusSession.model ?? '');
    if (unchanged) {
      setModelPanelOpen(false);
      return;
    }
    setApplyBusy(true);
    setApplyError(null);
    try {
      // Model change, Claude -> Claude: cheapest path — type `/model <name>`
      // straight into his live pty (no respawn, no conversation loss), per
      // plan §3.8. Every other case needs a fresh summon (`summonArceus`
      // already kills the existing session/terminal before spawning anew —
      // see `spawnArceus` in arceus.ts — reusing it here IS the kill-and-
      // resummon path, not a second implementation of one):
      //  - a provider change, either direction;
      //  - any change that involves codex on either side — codex's `/model`
      //    is an interactive picker, not a flag;
      //  - clearing a previously-set model back to "provider default" —
      //    there's no verified `/model <provider-default>` incantation to
      //    type into a live pty, so this resets him the same way a fresh
      //    summon with no `model` arg does;
      //  - Arceus isn't actually live right now (`status === 'done'`) — his
      //    pty may be a dead process, or (if the app's shell-fallback ever
      //    rode in under his id) a fallback shell that would silently no-op
      //    a `/model` write instead of erroring on it.
      const clearingModel = !newModel && !!arceusSession.model;
      const needsRespawn =
        newProvider !== arceusSession.provider ||
        newProvider === 'codex' ||
        clearingModel ||
        arceusSession.status === 'done';
      const saved = await loadArceusSummonConfig();
      const cwd = saved?.cwd ?? arceusSession.cwd;
      const autoMode = saved?.autoMode ?? false;
      const req = { cwd, model: newModel, autoMode, provider: newProvider };
      if (needsRespawn) {
        await summonArceus(req);
      } else if (newModel) {
        const res = await window.api.writePty(ARCEUS_SESSION_ID, `/model ${newModel}\r`);
        if (!res.ok) throw new Error(res.error ?? 'failed to send /model to arceus.');
        // Advisor fix: `summonArceus` (the `needsRespawn` branch above)
        // already stamps the new `model` via its own `addSession` call —
        // this is the cheap-path's equivalent for the live-pty case, so the
        // link label/`unchanged` short-circuit/next panel-open all read the
        // model that's ACTUALLY running instead of stale state.
        useStore.getState().updateSession(ARCEUS_SESSION_ID, { model: newModel });
      }
      await saveArceusSummonConfig(req);
      setModelPanelOpen(false);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <div className={showHud ? 'arceus-hud arceus-hud-visible' : 'arceus-hud'} aria-hidden={!showHud}>
      <div className="hud-summary-card">
        <div className="hud-head">
          <span className="hud-who">Arceus</span>
          {showModelSwitch && (
            <button
              type="button"
              className="hud-model-link"
              onClick={() => (modelPanelOpen ? setModelPanelOpen(false) : openModelPanel())}
            >
              {modelLinkLabel}
            </button>
          )}
        </div>
        <div className="hud-sentence">{summary}</div>
        <div className="hud-actions">
          <button type="button" className="hud-ghost-btn" onClick={() => setDetailsOpen((v) => !v)}>
            {detailsOpen ? 'hide details' : 'show details'}
          </button>
          <button type="button" className="hud-ghost-btn" onClick={() => setRefreshNonce((n) => n + 1)}>
            refresh
          </button>
        </div>
        {modelPanelOpen && showModelSwitch && (
          <div className="hud-model-panel">
            <div className="hud-model-panel-field">
              <label>provider</label>
              <select value={providerDraft} onChange={(e) => setProviderDraft(e.target.value as AgentProviderId)}>
                {ARCEUS_HUD_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {AGENT_PROVIDERS[id].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hud-model-panel-field">
              <label>model (optional)</label>
              <input
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                placeholder="defaults to the provider's own default"
                spellCheck={false}
              />
            </div>
            {applyError && <p className="error">{applyError}</p>}
            <button
              type="button"
              className="hud-ghost-btn"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void applyModelChange()}
              disabled={applyBusy}
            >
              {applyBusy ? 'applying…' : 'apply'}
            </button>
          </div>
        )}
      </div>

      <div className={detailsOpen ? 'hud-board' : 'hud-board hud-board-hidden'}>
        <div className="hud-board-head">
          <h2>garden status</h2>
          <span className="hud-board-live">● live</span>
        </div>
        <div className="hud-board-rows">
          {rows.length === 0 && <div className="hud-board-row-empty">no other agents in the garden yet.</div>}
          {rows.map((row) => (
            <div className="hud-board-row" key={row.id}>
              <div className="hud-board-glyph">{row.glyph}</div>
              <div className="hud-board-who">
                <div className="hud-board-name">{row.name}</div>
                <div className="hud-board-meta">{row.projectLabel}</div>
              </div>
              <div className={`hud-pill hud-pill-${row.status}`}>{row.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="hud-exchange-strip" ref={exchangeRef}>
        {exchange.length === 0 && <div className="hud-exchange-empty">nothing dispatched yet.</div>}
        {exchange.map((entry, i) => (
          <div
            key={`${entry.at}-${i}`}
            className={entry.who === 'arceus' ? 'hud-exchange-ln hud-exchange-ln-arceus' : 'hud-exchange-ln'}
          >
            <span className="hud-exchange-prompt">{entry.who === 'you' ? 'you>' : 'arceus>'}</span>{' '}
            <span className="hud-exchange-txt">{entry.text}</span>
          </div>
        ))}
      </div>

      <ArceusDispatchBox sessionId={ARCEUS_SESSION_ID} />
    </div>
  );
}
