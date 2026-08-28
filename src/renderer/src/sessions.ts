/** Session lifecycle: spawn a coding-agent CLI, wire its terminal, tear it down. */
import { AGENT_PROVIDERS, buildProviderArgs } from '@shared/agentProvider';
import type { NewSessionRequest } from '@shared/types';
import { useStore } from '@/store/store';
import { createTerminal, disposeTerminal, hasTerminal } from '@/pty/terminalRegistry';
import { pickFreeLine } from '@/scene/garden/showdownArt';
import { baseStageOf } from '@/scene/garden/dexData';
import { initShinyConfig, rollShiny } from '@/scene/garden/shiny';

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export async function startSession(req: NewSessionRequest): Promise<void> {
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const preset = AGENT_PROVIDERS[req.provider];
  const command = req.command.trim() || preset.defaultCommand;
  let sessionAdded = false;

  try {
    // Create the terminal FIRST: it subscribes to the PTY channels (so no
    // startup output is missed) and it must exist before the session appears in
    // the store, because the drawer attaches as soon as the new session becomes
    // selected.
    createTerminal(id);

    // Sessions always hatch at their line's base stage, whatever stage of the
    // line the picker's search resolved to.
    let pokemon: string;
    let line: string;
    if (req.pokemon) {
      const base = baseStageOf(req.pokemon);
      pokemon = base.id;
      line = base.line;
    } else {
      const picked = pickFreeLine(useStore.getState().takenLines());
      pokemon = picked.name;
      line = picked.line;
    }
    // The roll happens AFTER species/line resolution, per session, and is
    // awaited so a POKE_SHINY_ODDS override is guaranteed in effect even for
    // the very first session — the config's async IPC read might otherwise
    // still be in flight when the earliest possible session is created (see
    // shiny.ts's header).
    await initShinyConfig();
    const shiny = rollShiny();
    useStore.getState().addSession({
      id,
      title: req.title?.trim() || basename(req.cwd),
      cwd: req.cwd,
      command,
      provider: req.provider,
      model: req.model,
      pokemon,
      line,
      shiny
    });
    sessionAdded = true;

    const res = await window.api.spawnPty({
      id,
      cwd: req.cwd,
      command,
      args: buildProviderArgs(req.provider, req.model),
      env: preset.env,
      cols: 100,
      rows: 30,
      provider: req.provider
    });

    if (!res.ok) throw new Error(res.error ?? 'Failed to start session.');
    useStore.getState().updateSession(id, { status: 'idle', cwd: res.cwd ?? req.cwd });
  } catch (err) {
    // A failed spawn must not leave a stale store entry or a ghost tab: undo the
    // terminal and the store entry together rather than surfacing the failure as
    // a permanently-"done" session.
    if (hasTerminal(id)) disposeTerminal(id);
    if (sessionAdded) useStore.getState().removeSession(id);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function stopSession(id: string): Promise<void> {
  await window.api.killPty(id);
  disposeTerminal(id);
  useStore.getState().removeSession(id);
}
