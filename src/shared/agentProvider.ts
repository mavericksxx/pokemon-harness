/**
 * Agent providers — the coding-agent CLI a session runs.
 *
 * MINIMAL adaptation of munder-difflin's `src/shared/agentProvider.ts` (MIT,
 * Chaitanya Giri): same registry shape, three providers, none of the hive /
 * hook-bridge / proxy machinery. Shared between main and renderer, so keep it
 * dependency-free (no electron, no UI, no node).
 *
 * Auth is out of scope by design: we spawn the binary from PATH and the user is
 * already logged in via that CLI's own login flow.
 */

export type AgentProviderId = 'claude' | 'codex' | 'cursor-agent' | 'shell';

export interface AgentProviderPreset {
  id: AgentProviderId;
  label: string;
  /** The binary spawned when the user hasn't typed a custom command. */
  defaultCommand: string;
  /** Flag that selects the session model, when the CLI supports one. */
  modelFlag?: string;
  /** Whether to show a model field for this provider. */
  supportsModel: boolean;
  /** Environment forced on the child (first-run / non-interactive suppression). */
  env?: Record<string, string>;
}

export const AGENT_PROVIDERS: Record<AgentProviderId, AgentProviderPreset> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    modelFlag: '--model',
    supportsModel: true
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    defaultCommand: 'codex',
    modelFlag: '--model',
    supportsModel: true
  },
  'cursor-agent': {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    defaultCommand: 'cursor-agent',
    modelFlag: '--model',
    supportsModel: true
  },
  // Item 3 §3 (Phase 8.5 Wave B) — no agent CLI at all, just the user's own
  // shell. `defaultCommand` here is a fallback only: NewSessionDialog fills
  // the real command from `config:defaultShell` ($SHELL), since the actual
  // shell binary can't be known at this shared, dependency-free module's
  // scope. No hooks (pty.ts only wires them for 'claude'), no model field.
  shell: {
    id: 'shell',
    label: 'Plain Shell',
    defaultCommand: '/bin/zsh',
    supportsModel: false
  }
};

export const DEFAULT_PROVIDER: AgentProviderId = 'claude';

export const PROVIDER_LIST: AgentProviderPreset[] = Object.values(AGENT_PROVIDERS);

/** Build the argv for a provider spawn. Empty when nothing needs to be passed. */
export function buildProviderArgs(id: AgentProviderId, model?: string): string[] {
  const preset = AGENT_PROVIDERS[id];
  if (!preset.supportsModel || !preset.modelFlag || !model) return [];
  return [preset.modelFlag, model];
}
