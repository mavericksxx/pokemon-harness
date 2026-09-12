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
      // plan §3.8. Every other case (a provider change, or any change that
      // involves codex either side — codex's `/model` is an interactive
      // picker, not a flag) needs a fresh summon; `summonArceus` already
      // kills the existing session/terminal before spawning anew (see
      // `spawnArceus` in arceus.ts) — reusing it here IS the kill-and-
      // resummon path, not a second implementation of one.
      const needsRespawn = newProvider !== arceusSession.provider || newProvider === 'codex';
      const saved = await loadArceusSummonConfig();
      const cwd = saved?.cwd ?? arceusSession.cwd;
      const autoMode = saved?.autoMode ?? false;
      const req = { cwd, model: newModel, autoMode, provider: newProvider };
      if (needsRespawn) {
        await summonArceus(req);
      } else if (newModel) {
        const res = await window.api.writePty(ARCEUS_SESSION_ID, `/model ${newModel}\r`);
        if (!res.ok) throw new Error(res.error ?? 'failed to send /model to arceus.');
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
      <div className="summary-card">
        <div className="hud-head">
          <span className="hud-who">Arceus</span>
          <button
            type="button"
            className="model-link"
            onClick={() => (modelPanelOpen ? setModelPanelOpen(false) : openModelPanel())}
          >
            {modelLinkLabel}
          </button>
        </div>
        <div className="hud-sentence">{summary}</div>
        <div className="hud-actions">
          <button type="button" className="ghost-btn" onClick={() => setDetailsOpen((v) => !v)}>
            {detailsOpen ? 'hide details' : 'show details'}
          </button>
          <button type="button" className="ghost-btn" onClick={() => setRefreshNonce((n) => n + 1)}>
            refresh
          </button>
        </div>
        {modelPanelOpen && (
          <div className="model-panel">
            <div className="model-panel-field">
              <label>provider</label>
              <select value={providerDraft} onChange={(e) => setProviderDraft(e.target.value as AgentProviderId)}>
                {ARCEUS_HUD_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {AGENT_PROVIDERS[id].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="model-panel-field">
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
              className="ghost-btn"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void applyModelChange()}
              disabled={applyBusy}
            >
              {applyBusy ? 'applying…' : 'apply'}
            </button>
          </div>
        )}
      </div>

      <div className={detailsOpen ? 'board' : 'board board-hidden'}>
        <div className="board-head">
          <h2>garden status</h2>
          <span className="board-live">● live</span>
        </div>
        <div className="rows">
          {rows.length === 0 && <div className="row-empty">no other agents in the garden yet.</div>}
          {rows.map((row) => (
            <div className="row" key={row.id}>
              <div className="glyph">{row.glyph}</div>
              <div className="who-what">
                <div className="who-name">{row.name}</div>
                <div className="who-meta">{row.projectLabel}</div>
              </div>
              <div className={`pill ${row.status}`}>{row.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="exchange-strip" ref={exchangeRef}>
        {exchange.length === 0 && <div className="exchange-empty">nothing dispatched yet.</div>}
        {exchange.map((entry, i) => (
          <div key={i} className={entry.who === 'arceus' ? 'exchange-ln exchange-ln-arceus' : 'exchange-ln'}>
            <span className="exchange-prompt">{entry.who === 'you' ? 'you>' : 'arceus>'}</span>{' '}
            <span className="exchange-txt">{entry.text}</span>
          </div>
        ))}
      </div>

      <ArceusDispatchBox sessionId={ARCEUS_SESSION_ID} />
    </div>
  );
}
