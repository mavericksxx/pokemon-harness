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
  /** Argv appended when the user has explicitly opted into this provider's
   *  own autonomous permission mode (parity sweep item 1) — the CLI's own
   *  official flag(s) for "act without asking first", found from `--help`
   *  text only (never a real spawn). Absent = this provider has no such
   *  mode exposed to this app (its permission-mode toggle stays hidden). */
  autoModeArgs?: string[];
}

export const AGENT_PROVIDERS: Record<AgentProviderId, AgentProviderPreset> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    modelFlag: '--model',
    supportsModel: true,
    // `claude --help`: --permission-mode <mode>, choices "acceptEdits",
    // "auto", "bypassPermissions", "manual", "dontAsk", "plan" — "auto" is
    // both the least-broad autonomous choice and the value whose name
    // matches this app's required "auto mode" copy.
    autoModeArgs: ['--permission-mode', 'auto']
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    defaultCommand: 'codex',
    modelFlag: '--model',
    supportsModel: true,
    // `codex --help`: -a/--ask-for-approval <on-request|never> is the "act
    // without asking" axis, but codex's sandbox is a SEPARATE axis
    // (-s/--sandbox <read-only|workspace-write|danger-full-access|>). Paired
    // with `never` alone, an unspecified/read-only sandbox would leave the
    // agent unable to ask AND unable to act — the worst of both. --help's
    // own --approve-for-me ("route approval requests through automatic
    // review using the workspace-write sandbox") names workspace-write as
    // the intended pairing for unattended approval, so that's what "auto
    // mode — agents act without asking first" ships as here.
    autoModeArgs: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
  },
  'cursor-agent': {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    defaultCommand: 'cursor-agent',
    modelFlag: '--model',
    supportsModel: true
    // No autoModeArgs: cursor-agent isn't installed in this environment and
    // its --help text couldn't be read (the task scopes flag verification to
    // `claude --help` / `codex --help` only) — its permission-mode toggle
    // stays hidden rather than guessing a flag. See the parity sweep report.
  },
  // Item 3 §3 (Phase 8.5 Wave B) — no agent CLI at all, just the user's own
  // shell. `defaultCommand` here is a fallback only: NewSessionDialog fills
  // the real command from `config:defaultShell` ($SHELL), since the actual
  // shell binary can't be known at this shared, dependency-free module's
  // scope. No hooks (pty.ts only wires them for 'claude'), no model field.
  shell: {
    id: 'shell',
    label: 'plain shell',
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
