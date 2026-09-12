/**
 * HookBridge — Claude Code lifecycle hooks shim (Phase 4 Part A).
 *
 * Port of munder-difflin's hive.ts/hooks.ts mechanism (MIT, Chaitanya Giri),
 * trimmed to this app's needs: no cost ledger, no HITL gating, no roster
 * injection — just a dumb, fast relay from a `claude` session's hooks to the
 * renderer, so the garden can treat hook events as the authoritative state
 * source instead of scraping terminal text.
 *
 * Mechanism: on a claude spawn, we write a per-session `settings.json` whose
 * `hooks` block runs a tiny generated Node shim (`cth-hook.cjs`) for every
 * wired event. The shim reads the hook's JSON payload on stdin, stamps it
 * with `POKEHARNESS_AGENT_ID` (set on the child's env — see pty.ts), and
 * forwards it over a Unix domain socket this class listens on. We normalize
 * the payload and push it to the renderer over `hooks:event:<agentId>`; the
 * shim always gets `{}` back (this app never denies/gates a tool call at the
 * hook boundary).
 *
 * The shim itself is invoked by Claude via a bare `sh -c` with a stripped
 * PATH — a plain `node "<script>"` command 127s on a machine whose node only
 * lives on an interactive shell's PATH (nvm, etc). Electron's own binary is a
 * full Node runtime under ELECTRON_RUN_AS_NODE=1, so we write a tiny wrapper
 * script that runs the shim through it, exactly like the reference's
 * `hive-node` launcher.
 */
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { log } from './diagnostics';
import {
  isKnownHookEvent,
  normalizeToolName,
  subagentTypeFromInput,
  toolTargetFromInput,
  type DelegateHookSignal,
  type HookEvent,
  type HookPayload
} from '../shared/hookEvents';
import type { DelegateSpawnRequest, DelegateSpawnResponse } from '../shared/delegateSpawn';
import { ARCEUS_SESSION_ID } from '../shared/arceus';
import type { PokeAskRequest, PokeRelayRequest, PokeSpawnRequest, PokeToolResponse } from '../shared/pokeTools';

/** Env var the shim reads to find the UDS to dial. */
export const HOOK_SOCK_ENV = 'POKE_HOOK_SOCK';
/** Env var the shim stamps onto every payload as `harness_agent_id`.
 *
 *  Namespaced as `POKEHARNESS_AGENT_ID` (not the bare `AGENT_ID` this used
 *  pre-BACKLOG-item-3): a live hook capture showed a subagent's tool-call
 *  hooks carrying a DIFFERENT value for `AGENT_ID` than the parent's,
 *  suggesting Claude Code itself may set its own env var of that name for
 *  subagent-scoped hook commands — which would silently clobber ours and
 *  misroute events. Prefixing makes the collision impossible regardless of
 *  whether that CLI behavior is ever confirmed. Safe to rename outright with
 *  no dual-read compat shim: the shim script that reads this is rewritten
 *  unconditionally by `ensureFiles()` on every app start, before any pty can
 *  spawn (see `app.whenReady` in index.ts), so setter (pty.ts, via this
 *  constant) and reader (the regenerated shim) can never disagree. */
export const AGENT_ID_ENV = 'POKEHARNESS_AGENT_ID';

/** External-codex-delegate feature — env vars an orchestrator sets on its own
 *  `codex exec` launch (never on a harness-spawned pty, which knows nothing
 *  about delegates). Codex spawns each hook invocation as a child process of
 *  that `codex exec`, so these inherit into the shim's env exactly the same
 *  way AGENT_ID_ENV does for a real harness session — read at hook-run time,
 *  below. `DELEGATE_PARENT_ENV` names the harness session id the delegate
 *  battler attaches to; `DELEGATE_LABEL_ENV` is an optional card title. */
export const DELEGATE_PARENT_ENV = 'POKEHARNESS_DELEGATE_PARENT';
export const DELEGATE_LABEL_ENV = 'POKEHARNESS_DELEGATE_LABEL';

const SHIM_FILENAME = 'cth-hook.cjs';
const CLI_SHIM_DIRNAME = 'cli-shims';
const CLI_JSON_HELPER_FILENAME = 'cli-json-string.cjs';
/** Codex-flavored sibling shim's filename (see `CODEX_HOOK_SHIM` below) —
 *  also the substring codexHooks.ts matches on to recognize "this is our own
 *  hooks.json entry, from THIS install" regardless of the exact absolute
 *  launcher/shim path (which embeds `userData` and so differs between a dev
 *  and a packaged build). */
export const CODEX_SHIM_FILENAME = 'cth-hook-codex.cjs';

/** First-class delegate sessions (shared/delegateSpawn.ts) — client CLI
 *  filename, installed alongside the hook shims for the same reason: the
 *  orchestrator (a Claude CLI running inside a harness pty) runs this via its
 *  own Bash tool to ask the app to spawn a real `codex exec` pty session. */
export const DELEGATE_CLI_FILENAME = 'poke-delegate.cjs';

/** Arceus v2 (docs/arceus-v2-plan.md §3.2/§7) — the three new tool commands,
 *  installed as bare PATH-resolvable wrappers in their OWN directory,
 *  deliberately separate from `CLI_SHIM_DIRNAME` above (which shadows
 *  `claude`/`codex` and must never be on Arceus's own PATH). Only prepended
 *  to PATH for an ARCEUS spawn on the claude provider — see pty.ts's
 *  `spawn()` — so a bare `poke-ask`/`poke-spawn`/`poke-relay` won't resolve
 *  by name from any other session's shell. That's discoverability only, not
 *  a security boundary: the files still exist at a fixed absolute path any
 *  same-user process could run directly — the real gate is the
 *  `parentAgentId` guard every handler below enforces regardless (see
 *  `isFromArceus`'s own caveat on what that guard actually stops). */
const POKE_TOOLS_DIRNAME = 'poke-tools-bin';
/** Shared implementation the three wrapper commands all exec into (argv[2]
 *  names which one: 'poke-ask' | 'poke-spawn' | 'poke-relay') — one script
 *  instead of three near-identical ones, same "small, dumb, one UDS round
 *  trip" spirit as poke-delegate's own `DELEGATE_CLI_SCRIPT`. */
const POKE_TOOLS_SCRIPT_FILENAME = 'poke-tools.cjs';

/** `permissions.allow` entries added to Arceus's own per-session settings
 *  (see `prepareSession`'s `extraAllowRules` param) so auto-mode-off doesn't
 *  stall him on an unattended permission prompt for any of the three new
 *  commands — mirrors Claude Code's documented `Bash(<prefix>:*)` allow-rule
 *  syntax (a prefix match against the Bash tool's own command STRING, a
 *  decision made before the shell ever tries to resolve/run it — unrelated
 *  to PATH).
 *
 *  UNVERIFIED, flagged rather than silently assumed: this repo has no prior
 *  example of a `Bash(<cmd>:*)` allow-rule matching a BARE, PATH-resolved
 *  command name (poke-delegate, the closest precedent, isn't gated by any
 *  permission-allow rule at all — it relies on auto-mode/manual approval).
 *  This app cannot launch a real `claude` session to confirm empirically.
 *  Needs a live check before this feature is considered fully done: summon
 *  Arceus with auto-mode OFF, ask him to call `poke-ask`, and confirm no
 *  permission prompt appears. If it turns out prefix-matching needs an
 *  absolute path instead of a bare name, `pty.ts`'s PATH-prepend approach
 *  would need to change to something that stamps a resolved path into these
 *  rules per-install. */
export const POKE_TOOL_PERMISSION_RULES = ['Bash(poke-ask:*)', 'Bash(poke-spawn:*)', 'Bash(poke-relay:*)'];

/** Cap on one UDS connection's buffered-so-far line (`bind()`'s
 *  `conn.on('data')`, below) — the shim always writes one JSON line then
 *  waits for a reply, so a legitimate payload never approaches this, but
 *  nothing previously stopped `buf` from growing unbounded if a line's
 *  newline never arrived (a wedged/misbehaving client). */
const MAX_HOOK_LINE_BYTES = 1024 * 1024; // 1 MiB

const CLI_JSON_HELPER = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[2], 'utf8')));
`;

/** Fallback-shell claude shim. The real path is resolved by PtyManager before
 *  this directory is prepended to PATH, so the shim cannot resolve itself. */
const CLAUDE_CLI_SHIM = `#!/bin/sh
set -eu
real=\${POKEHARNESS_REAL_CLAUDE:-}
[ -n "\$real" ] || {
  old_ifs=\$IFS; IFS=:
  for dir in \$PATH; do
    IFS=\$old_ifs
    [ "\$dir" = "\${POKEHARNESS_CLI_SHIM_DIR:-}" ] && continue
    if [ -x "\$dir/claude" ]; then real="\$dir/claude"; break; fi
    IFS=:
  done
  IFS=\$old_ifs
}
[ -n "\$real" ] || { echo "claude: command not found" >&2; exit 127; }
settings_present=false
instructions_present=false
for arg in "\$@"; do
  [ "\$arg" = "--settings" ] && settings_present=true
  case "\$arg" in --settings=*) settings_present=true;; esac
  [ "\$arg" = "--append-system-prompt-file" ] && instructions_present=true
  case "\$arg" in --append-system-prompt-file=*) instructions_present=true;; esac
done
if [ "\$settings_present" = false ] && [ -n "\${POKEHARNESS_CLAUDE_SETTINGS:-}" ]; then
  set -- "\$@" --settings "\$POKEHARNESS_CLAUDE_SETTINGS"
fi
if [ "\$instructions_present" = false ] && [ -n "\${POKEHARNESS_INSTRUCTIONS:-}" ] && [ -f "\$POKEHARNESS_INSTRUCTIONS" ]; then
  set -- "\$@" --append-system-prompt-file "\$POKEHARNESS_INSTRUCTIONS"
fi
exec "\$real" "\$@"
`;

/** Fallback-shell codex shim. JSON.stringify is delegated to the bundled
 *  Node launcher so escaping matches spawn() exactly for every HARNESS.md. */
const CODEX_CLI_SHIM = `#!/bin/sh
set -eu
real=\${POKEHARNESS_REAL_CODEX:-}
[ -n "\$real" ] || {
  old_ifs=\$IFS; IFS=:
  for dir in \$PATH; do
    IFS=\$old_ifs
    [ "\$dir" = "\${POKEHARNESS_CLI_SHIM_DIR:-}" ] && continue
    if [ -x "\$dir/codex" ]; then real="\$dir/codex"; break; fi
    IFS=:
  done
  IFS=\$old_ifs
}
[ -n "\$real" ] || { echo "codex: command not found" >&2; exit 127; }
if [ -n "\${POKEHARNESS_INSTRUCTIONS:-}" ] && [ -f "\$POKEHARNESS_INSTRUCTIONS" ]; then
  quoted=\$("\${POKEHARNESS_NODE:?}" "\${POKEHARNESS_JSON_HELPER:?}" "\$POKEHARNESS_INSTRUCTIONS")
  set -- "\$@" -c "developer_instructions=\$quoted"
fi
exec "\$real" "\$@"
`;

/** The generated shim script. Deliberately dumb: read stdin, add
 *  harness_agent_id from env, forward to the socket, print whatever comes
 *  back (Claude expects hook stdout to be either empty or a JSON
 *  hookSpecificOutput blob), exit. Never blocks longer than a few seconds
 *  even if the app is gone.
 *
 *  Stamped field is `harness_agent_id`, NOT `agent_id`: confirmed via a live
 *  claude session that Claude Code's own hook payloads for a subagent's
 *  (Task tool) tool calls and its SubagentStop already carry a top-level
 *  `agent_id` (+ `agent_type`) identifying the CLI's *internal* subagent —
 *  unrelated to this app's session id. Stamping into `agent_id` collided
 *  with that and misrouted every subagent-scoped event to a channel the
 *  renderer never subscribes to (see HookBridge.handle below). Always
 *  overwritten, never guarded — this field name is ours alone.
 *
 *  Also stamps `harness_delegate_parent`/`harness_delegate_label` from
 *  DELEGATE_PARENT_ENV/DELEGATE_LABEL_ENV, read at hook-run time exactly
 *  like `harness_agent_id` above — null on every ordinary harness session
 *  (those two vars are never set on a harness-spawned pty), present only
 *  when this exact hook invocation's own env carries them (an external
 *  `codex exec` delegate run — see HookBridge.handleDelegate). */
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  payload.harness_agent_id = process.env.${AGENT_ID_ENV} || null;
  payload.harness_delegate_parent = process.env.${DELEGATE_PARENT_ENV} || null;
  payload.harness_delegate_label = process.env.${DELEGATE_LABEL_ENV} || null;
  const sock = process.env.${HOOK_SOCK_ENV};
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

/** Codex-flavored sibling shim (main/codexHooks.ts's `ensureCodexHooks` wires
 *  this into codex's own `$CODEX_HOME/hooks.json`, not any Claude settings
 *  file) — a translator, not a copy of HOOK_SHIM above, for one
 *  deliberate reason: it NEVER stamps `harness_agent_id`.
 *
 *  A delegate `codex exec` is launched from inside a harness `claude` pty
 *  (the "orchestrator" — see DELEGATE_PARENT_ENV's own doc comment), which
 *  means it inherits that pty's ENTIRE environment as its own process env,
 *  including that pty's own `POKEHARNESS_AGENT_ID` — confirmed against
 *  codex's source (openai/codex @ 0.150.1, codex-rs/hooks/src/registry.rs:
 *  `Hooks::new` snapshots `std::env::vars_os()` once at codex startup, and
 *  codex-rs/protocol/src/shell_environment.rs's `scrub_non_inheritable_env_
 *  vars` only strips a short fixed list of codex-internal auth/identity
 *  vars — nothing of ours — so a hook subprocess DOES see whatever env the
 *  `codex exec` process itself launched with, unfiltered by codex's separate
 *  `shell_environment_policy`, which only governs the model's own shell-tool
 *  calls). If this shim stamped `harness_agent_id` the same way HOOK_SHIM
 *  does, every codex delegate event would carry the ORCHESTRATOR's own
 *  agentId, and HookBridge.handle's `if (!agentId)` branch would route it
 *  onto the orchestrator's own `hooks:event:<agentId>` channel instead of
 *  `handleDelegate` below — corrupting the parent's own status/battle state
 *  with a codex session's events, exactly what `handleDelegate`'s routing
 *  exists to prevent. Leaving `harness_agent_id` unset (undefined, not even
 *  null) is what makes `HookBridge.handle`'s early check treat every codex
 *  payload as delegate-or-unrelated, never as a harness session's own event.
 *
 *  Field names on the payload this reads (`hook_event_name`, `session_id`)
 *  need no translation — confirmed identical to Claude's via codex's own
 *  generated JSON schemas (codex-rs/hooks/schema/generated/session-start.
 *  command.input.schema.json, stop.command.input.schema.json: both list
 *  `hook_event_name` and `session_id` as required string fields) — so this
 *  shim only needs to ADD the two delegate fields, never rename anything. */
const CODEX_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  payload.harness_delegate_parent = process.env.${DELEGATE_PARENT_ENV} || null;
  payload.harness_delegate_label = process.env.${DELEGATE_LABEL_ENV} || null;
  const sock = process.env.${HOOK_SOCK_ENV};
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

/** First-class delegate sessions (shared/delegateSpawn.ts) — the client CLI
 *  an orchestrator (a Claude CLI running inside a harness pty) runs, via its
 *  own Bash tool, to ask this app to spawn a real `codex exec` pty session on
 *  its behalf. Deliberately dumb, mirroring HOOK_SHIM/CODEX_HOOK_SHIM above:
 *  no argv library, a single UDS round-trip, print-and-exit.
 *
 *  Discovery/auth is identity via inherited env, same mechanism the hook
 *  shims themselves rely on (this file's own header) — `POKE_HOOK_SOCK` and
 *  `POKEHARNESS_AGENT_ID` are set on the ORCHESTRATOR's own pty process (see
 *  pty.ts's `spawn()`, provider === 'claude' branch), so any command that
 *  process runs — including this script, via its own shell tool — inherits
 *  both. No separate bearer token: the socket lives under this app's own
 *  userData directory, and only a descendant of an app-spawned claude pty
 *  ever sees these two env vars at all. `parentAgentId` is therefore always
 *  read from env, never accepted as a flag — an orchestrator can only name
 *  itself as a delegate's parent. */
const DELEGATE_CLI_SCRIPT = `#!/usr/bin/env node
'use strict';
const net = require('net');

function fail(msg) {
  process.stderr.write('poke-delegate: ' + msg + '\\n');
  process.exit(1);
}

const sock = process.env.${HOOK_SOCK_ENV};
const parentAgentId = process.env.${AGENT_ID_ENV};
if (!sock || !parentAgentId) {
  fail('not running inside a pok\\u00e9harness session (run this from an orchestrator pty)');
}

const argv = process.argv.slice(2);
let cwd;
let label;
let effort;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cwd') cwd = argv[++i];
  else if (a === '--label') label = argv[++i];
  else if (a === '--effort') effort = argv[++i];
  else rest.push(a);
}
const prompt = rest.join(' ').trim();
if (!cwd) fail('--cwd <path> is required');
if (!prompt) fail('a prompt is required');

const payload = {
  type: 'delegate/spawn',
  parentAgentId,
  cwd,
  prompt,
  label: label || undefined,
  reasoningEffort: effort || undefined
};

let resp = '';
const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
c.setEncoding('utf8');
c.on('data', (d) => { resp += d; });
c.on('error', (e) => fail('could not reach pok\\u00e9harness: ' + e.message));
c.on('end', () => {
  let result = {};
  try { result = JSON.parse(resp || '{}'); } catch (_) {}
  if (result && result.ok) {
    process.stdout.write((result.id || '') + '\\n');
    process.exit(0);
  }
  fail(result && result.error ? result.error : 'spawn failed');
});
setTimeout(() => fail('timed out waiting for pok\\u00e9harness'), 10000).unref();
`;

/** Arceus v2 — shared implementation for `poke-ask`/`poke-spawn`/
 *  `poke-relay`. `argv[2]` (a literal string baked into each wrapper —
 *  see `ensureFiles()`'s wrapper-writing loop below) names which tool is
 *  running; everything after it is that tool's own arguments. Same UDS
 *  round-trip shape as
 *  `DELEGATE_CLI_SCRIPT` above, deliberately NOT waiting for the real
 *  outcome (docs/arceus-v2-plan.md §3.2/§4 spike 1) — the ack this prints is
 *  the whole point: Claude Code's own Bash tool refuses to block
 *  synchronously on an external event, so the actual answer/spawn/relay
 *  arrives later as a fresh pty message, never as this command's own output. */
const POKE_TOOLS_SCRIPT = `#!/usr/bin/env node
'use strict';
const net = require('net');

const tool = process.argv[2];

function fail(msg) {
  process.stderr.write((tool || 'poke-tool') + ': ' + msg + '\\n');
  process.exit(1);
}

const sock = process.env.${HOOK_SOCK_ENV};
const parentAgentId = process.env.${AGENT_ID_ENV};
if (!sock || !parentAgentId) {
  fail('not running inside a pok\\u00e9harness session (only arceus can run this)');
}

const argv = process.argv.slice(3);
let payload;

function takeFlag(flag) {
  const rest = [];
  let value;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) value = argv[++i];
    else rest.push(argv[i]);
  }
  return { value, rest };
}

if (tool === 'poke-ask') {
  const question = argv[0];
  const options = argv.slice(1).map((o) => o.trim()).filter(Boolean);
  if (!question || !question.trim()) fail('usage: poke-ask "<question>" "<option 1>" ["<option 2>" ...]');
  if (options.length === 0) fail('at least one option is required');
  payload = { type: 'poke/ask', parentAgentId, question: question.trim(), options };
} else if (tool === 'poke-spawn') {
  const { value: workspace, rest } = takeFlag('--workspace');
  const task = rest.join(' ').trim();
  if (!workspace) fail('usage: poke-spawn --workspace <id or name> <initial task>');
  if (!task) fail('an initial task is required');
  payload = { type: 'poke/spawn', parentAgentId, workspace, task };
} else if (tool === 'poke-relay') {
  const { value: agent, rest } = takeFlag('--agent');
  const message = rest.join(' ').trim();
  if (!agent) fail('usage: poke-relay --agent <id, title, or species> <message>');
  if (!message) fail('a message is required');
  payload = { type: 'poke/relay', parentAgentId, agent, message };
} else {
  fail('unknown tool: ' + tool);
}

let resp = '';
const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
c.setEncoding('utf8');
c.on('data', (d) => { resp += d; });
c.on('error', (e) => fail('could not reach pok\\u00e9harness: ' + e.message));
c.on('end', () => {
  let result = {};
  try { result = JSON.parse(resp || '{}'); } catch (_) {}
  if (result && result.ok) {
    process.stdout.write((result.note || 'accepted') + (result.id ? ' (' + result.id + ')' : '') + '\\n');
    process.exit(0);
  }
  fail(result && result.error ? result.error : 'request failed');
});
setTimeout(() => fail('timed out waiting for pok\\u00e9harness'), 10000).unref();
`;

export class HookBridge {
  private server: Server | null = null;
  private readonly binDir: string;
  private readonly shimFile: string;
  private readonly codexShimFile: string;
  private readonly delegateCliFile: string;
  private readonly launcherFile: string;
  private readonly cliShimDir: string;
  private readonly cliJsonHelperFile: string;
  private readonly pokeToolsDir: string;
  private readonly pokeToolsScriptFile: string;
  readonly sockPath: string;
  /** Identity of the socket file we're CURRENTLY bound to, captured right
   *  after `listen()` succeeds. Existence alone can't tell "our socket" from
   *  a foreign one at the same path — a second app instance `rmSync`s +
   *  recreates `hooks.sock` at this exact path (see this file's header for
   *  the incident this fixes), so `checkSocketHealth` below compares the
   *  live file's (dev, ino) against this rather than just checking presence. */
  private sockIdentity: { dev: number; ino: number } | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** True from the moment `bind()` calls `listen()` until its callback (or
   *  its `'error'` handler) fires. `listen()` binds the path synchronously
   *  but Node defers that callback to a later tick — a `checkSocketHealth()`
   *  landing in that window would see a live, correct socket file but a
   *  still-stale (or null) `sockIdentity`, read that as "foreign", and tear
   *  down the very server it's mid-bind. Both `checkSocketHealth` call sites
   *  (the timer and pty.ts's on-demand call) are guarded by this instead. */
  private bindPending = false;
  /** Guards "one toast per incident" (checkSocketHealth's doc comment) — set
   *  the moment self-heal fires, cleared once a rebind actually succeeds
   *  (`recordSockIdentity`) so a LATER, separate incident still gets its own
   *  toast rather than being silently swallowed forever by one stale flag. */
  private toastSentForIncident = false;
  /** BACKLOG "next up" item 2 — mirrors index.ts's `keepAwakeEnabled` module
   *  variable pattern for a setting read at spawn time rather than passed
   *  through per-call. Default off so a freshly-constructed bridge (tests,
   *  other callers) behaves exactly as before this setting existed. */
  private hideStatusline = false;

  constructor(
    userDataDir: string,
    private getWebContents: () => WebContents | null,
    /** Phase 8.5 Wave B item 1 — fired with every payload that has a known
     *  agentId, regardless of event type or whether it's forwarded to the
     *  renderer, so the cost/context HUD's transcript-path registration
     *  (idempotent — see costWatcher.ts) isn't tied to any one hook event.
     *  Optional so this class stays usable standalone (tests, other
     *  callers) without a cost watcher in the loop.
     *
     *  Also carries `hook_event_name` and `agent_id` straight off the same
     *  payload (2026-09-06 stale-registration fix): a registration call for
     *  an agentId that's already tracked against a DIFFERENT transcript path
     *  (a `/clear`, or Arceus's `tryResumeArceus` respawning under the same
     *  fixed agentId — see costWatcher.ts's `registerSession`) needs to tell
     *  a genuine top-level SessionStart apart from a subagent-scoped payload
     *  (which carries its own `agent_id`/`agent_type` and must never reset
     *  the parent's tracked state) before it's safe to drop the stale state
     *  and re-track the new path. */
    private onRawPayload?: (
      agentId: string,
      transcriptPath: string | undefined,
      hookEventName: string | undefined,
      subagentAgentId: string | undefined
    ) => void,
    /** External-codex-delegate feature — validates a delegate's
     *  `POKEHARNESS_DELEGATE_PARENT` actually names a live harness session
     *  before `handleDelegate` forwards anything to the renderer, so a
     *  stale/typo'd parent id can't spawn an orphaned battler. Optional so
     *  this class stays usable standalone (tests, other callers) without a
     *  live PtyManager in the loop, same reasoning as `onRawPayload` above. */
    private isKnownSession?: (id: string) => boolean,
    /** First-class delegate sessions — invoked once a `delegate/spawn`
     *  request (shared/delegateSpawn.ts) has passed this class's own
     *  validation (parent known, cwd exists — see `handleDelegateSpawn`
     *  below); owns the actual `ptyManager.spawn()` call and the renderer
     *  notification, since this class holds neither. Optional for the same
     *  standalone-usability reason as `isKnownSession`/`onRawPayload` above —
     *  without it, a well-formed request still validates but gets a plain
     *  "not wired" error instead of silently hanging. */
    private onDelegateSpawnRequest?: (req: DelegateSpawnRequest) => DelegateSpawnResponse,
    /** Arceus v2 — validated (parentAgentId === ARCEUS_SESSION_ID, per this
     *  class's own guard) then handed off, same "optional so this class
     *  stays usable standalone" reasoning as every other callback above.
     *  Each owns its own side effect: `onPokeAsk` pushes a picker to the
     *  renderer, `onPokeSpawn` spawns a real pty (like
     *  `onDelegateSpawnRequest` does) and notifies the renderer to adopt it,
     *  `onPokeRelay` resolves the target and queues the injection. None of
     *  the three block on the eventual outcome — see this file's
     *  `POKE_TOOLS_SCRIPT` header. */
    private onPokeAsk?: (req: PokeAskRequest) => PokeToolResponse,
    private onPokeSpawn?: (req: PokeSpawnRequest) => PokeToolResponse,
    private onPokeRelay?: (req: PokeRelayRequest) => PokeToolResponse
  ) {
    this.binDir = join(userDataDir, 'hooks-bin');
    this.shimFile = join(this.binDir, SHIM_FILENAME);
    this.codexShimFile = join(this.binDir, CODEX_SHIM_FILENAME);
    this.delegateCliFile = join(this.binDir, DELEGATE_CLI_FILENAME);
    this.launcherFile = join(this.binDir, process.platform === 'win32' ? 'poke-node.cmd' : 'poke-node');
    this.cliShimDir = join(this.binDir, CLI_SHIM_DIRNAME);
    this.cliJsonHelperFile = join(this.cliShimDir, CLI_JSON_HELPER_FILENAME);
    this.pokeToolsDir = join(this.binDir, POKE_TOOLS_DIRNAME);
    this.pokeToolsScriptFile = join(this.pokeToolsDir, POKE_TOOLS_SCRIPT_FILENAME);
    this.sockPath = join(userDataDir, 'hooks.sock');
  }

  /** Write the shim(s) + delegate CLI + bundled-node launcher. Idempotent,
   *  refreshed every call so a code change always takes effect on the next
   *  app start. Writes the codex-flavored shim and the delegate CLI
   *  unconditionally, same as the claude shim — both are inert files on disk
   *  until something actually invokes them (codexHooks.ts's
   *  `ensureCodexHooks` for the former, an orchestrator running
   *  `poke-delegate.cjs` for the latter), so writing them here has no
   *  behavior cost. */
  ensureFiles(): void {
    mkdirSync(this.binDir, { recursive: true });
    mkdirSync(this.cliShimDir, { recursive: true });
    mkdirSync(this.pokeToolsDir, { recursive: true });
    writeFileSync(this.shimFile, HOOK_SHIM, 'utf8');
    writeFileSync(this.codexShimFile, CODEX_HOOK_SHIM, 'utf8');
    writeFileSync(this.delegateCliFile, DELEGATE_CLI_SCRIPT, 'utf8');
    writeFileSync(join(this.cliShimDir, 'claude'), CLAUDE_CLI_SHIM, 'utf8');
    writeFileSync(join(this.cliShimDir, 'codex'), CODEX_CLI_SHIM, 'utf8');
    writeFileSync(this.cliJsonHelperFile, CLI_JSON_HELPER, 'utf8');
    writeFileSync(this.pokeToolsScriptFile, POKE_TOOLS_SCRIPT, 'utf8');
    try {
      chmodSync(join(this.cliShimDir, 'claude'), 0o755);
      chmodSync(join(this.cliShimDir, 'codex'), 0o755);
      chmodSync(this.cliJsonHelperFile, 0o755);
      // Arceus v2 — three bare-command wrappers, one per tool name, all
      // exec'ing the same shared `poke-tools.cjs` (this file's own
      // `POKE_TOOLS_SCRIPT`) through the bundled-node launcher below, same
      // "$0 as a literal argument" trick used to avoid three near-duplicate
      // implementation files. Posix-only (this app is macOS-only) — no
      // win32 branch, same as the cli-shims directory just above.
      for (const name of ['poke-ask', 'poke-spawn', 'poke-relay']) {
        const wrapperPath = join(this.pokeToolsDir, name);
        writeFileSync(
          wrapperPath,
          `#!/bin/sh\nexec "${this.launcherFile}" "${this.pokeToolsScriptFile}" "${name}" "$@"\n`,
          'utf8'
        );
        chmodSync(wrapperPath, 0o755);
      }
      if (process.platform === 'win32') {
        writeFileSync(
          this.launcherFile,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        writeFileSync(
          this.launcherFile,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`,
          'utf8'
        );
        chmodSync(this.launcherFile, 0o755);
      }
    } catch (e) {
      console.error('[hooks] writing node launcher failed:', e);
    }
  }

  /** Directory prepended to fallback-shell PATH for hand-relaunched CLIs. */
  cliShimPath(): string {
    return this.cliShimDir;
  }

  /** Bundled Node launcher used by the codex shim's JSON.stringify helper. */
  nodeLauncherPath(): string {
    return this.launcherFile;
  }

  /** Helper that emits a JSON.stringify-compatible string literal. */
  cliJsonHelperPath(): string {
    return this.cliJsonHelperFile;
  }

  /** Arceus v2 — directory prepended to PATH for an Arceus spawn only (see
   *  pty.ts's `spawn()`), holding the `poke-ask`/`poke-spawn`/`poke-relay`
   *  bare-command wrappers. */
  pokeToolsPath(): string {
    return this.pokeToolsDir;
  }

  /** Start listening on the UDS. Independent of any live claude session — the
   *  server must be up before the first spawn ever happens, and a fake-payload
   *  shim run (verification) must be able to reach it with no session live. */
  start(): void {
    if (this.server) return;
    this.bind();
    // Socket inode self-heal (hooks.sock clobber bug) — periodic safety net
    // for whenever nothing proactively calls `checkSocketHealth` in time
    // (e.g. a second app instance replaces hooks.sock while every session is
    // idle, between spawns). unref()'d so this timer never itself keeps the
    // app process alive.
    this.healthTimer = setInterval(() => this.checkSocketHealth(), 5000);
    this.healthTimer.unref();
  }

  /** Actual bind/listen, factored out of `start()` so `checkSocketHealth`'s
   *  rebind path can reuse it verbatim. */
  private bind(): void {
    this.bindPending = true;
    this.removeForeignSocketFile();
    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        if (buf.length > MAX_HOOK_LINE_BYTES) {
          log('hooks', 'warn', 'hook connection exceeded max line size — dropped', {
            length: buf.length,
            remoteAddress: conn.remoteAddress,
            remotePort: conn.remotePort
          });
          conn.destroy();
          buf = '';
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(buf.slice(0, nl));
        } catch (e) {
          // Malformed line — respond empty rather than hang the shim.
          // Capped: this is the one place raw, agent-controlled content
          // enters the diagnostics log, and it can carry user prompt/file
          // text — log a short breadcrumb (parse error, length, a 120-char
          // prefix) rather than the raw payload.
          const raw = buf.slice(0, nl);
          log('hooks', 'warn', 'malformed hook payload — dropped', {
            error: e instanceof Error ? e.message : String(e),
            length: raw.length,
            prefix: raw.slice(0, 120)
          });
        }
        void this.dispatch(parsed).then((res) => {
          // Always write a response and end the connection — the shim/CLI
          // blocks on this until its own timeout, and every subsequent tool
          // call in that session would stall by that long if we ever forgot
          // to reply.
          conn.end(JSON.stringify(res ?? {}));
        });
      });
      conn.on('error', () => {
        /* shim hung up early — ignore */
      });
    });
    this.server.on('error', (e: NodeJS.ErrnoException) => {
      // EADDRINUSE here means a second app instance is running (both bind
      // the same per-userData sockPath) — harmless: the first instance's
      // socket keeps serving hooks fine, the second just won't route any
      // (see BACKLOG's known-items note this closes). Should be rare now
      // that index.ts holds a single-instance lock (a second launch quits
      // before ever reaching hookBridge), but kept as a defensive fallback.
      this.bindPending = false;
      if (e.code === 'EADDRINUSE') {
        log('hooks', 'warn', 'hooks socket already in use — likely a second app instance; its hook events will be dropped', {
          sockPath: this.sockPath
        });
      } else {
        log('hooks', 'error', 'hooks socket server error', { message: e.message, code: e.code });
      }
    });
    this.server.listen(this.sockPath, () => this.recordSockIdentity());
  }

  /** Remove whatever currently sits at `sockPath` before a (re)bind — but
   *  ONLY if it's itself a socket. A stale UDS file (a crashed prior run, or
   *  one a foreign instance left behind) is safe to unlink; a REGULAR file
   *  never is, on the off chance something else ever collides on this exact
   *  path — same rule `stop()` applies on the way out. */
  private removeForeignSocketFile(): void {
    try {
      if (existsSync(this.sockPath) && statSync(this.sockPath).isSocket()) {
        rmSync(this.sockPath);
      }
    } catch {
      /* best-effort — a stale socket file from a crashed prior run */
    }
  }

  /** Captures (dev, ino) for the socket file right after a successful
   *  `listen()`, and clears the "already toasted" guard so a later, separate
   *  incident gets its own toast. */
  private recordSockIdentity(): void {
    try {
      const st = statSync(this.sockPath);
      this.sockIdentity = { dev: st.dev, ino: st.ino };
    } catch (e) {
      log('hooks', 'error', 'failed to stat hooks.sock right after listen', {
        message: e instanceof Error ? e.message : String(e)
      });
    }
    this.toastSentForIncident = false;
    this.bindPending = false;
  }

  /** True only while `sockPath` still points at the exact socket we're bound
   *  to. False for a missing path (ENOENT) or one that now resolves to a
   *  different (dev, ino) — either way, someone else has the name now. */
  private isSockPathOurs(): boolean {
    if (!this.sockIdentity) return false;
    try {
      const st = statSync(this.sockPath);
      return st.dev === this.sockIdentity.dev && st.ino === this.sockIdentity.ino;
    } catch {
      return false;
    }
  }

  /** Socket inode self-heal. Cheap (one `statSync`) — safe to call both from
   *  the periodic timer above and on-demand, right before the main process
   *  spawns a session or a delegate (see pty.ts's `spawn()`), so a session
   *  that's about to need working hooks gets a freshly-verified socket
   *  rather than waiting up to 5s for the next timer tick.
   *
   *  If the path is missing or foreign (a second app instance clobbered it —
   *  this file's header), closes the OLD server and binds a fresh one at the
   *  same path. `server.close()` only stops the OLD server from accepting
   *  NEW connections; any connection already in flight on it (a shim mid
   *  round-trip) finishes normally — closing doesn't touch it — so this
   *  never drops an in-flight hook beyond that already-existing `close()`
   *  contract.
   *
   *  Deliberately does NOT protect a foreign file the way `stop()` does
   *  (see that method's own comment on `close()`'s unlink-by-path
   *  behavior): reclaiming the path is the entire point of a rebind, and
   *  `bind()`'s own `removeForeignSocketFile()` already removes a foreign
   *  SOCKET on purpose (never a regular file). In the real scenario this
   *  fixes — a dead file a since-exited second instance left behind —
   *  that's exactly correct. It's only asymmetric with `stop()` if the
   *  "foreign" owner at this path happens to be a second instance that's
   *  still genuinely alive (a lock-bypass edge case `stop()` treats as
   *  "leave it alone"); this method still reclaims the path in that case,
   *  since a bridge that can't route hooks at all is worse than one that
   *  wins a rare race against another live bridge doing the same thing. */
  checkSocketHealth(): void {
    if (!this.server) return; // start() never called — standalone/test usage
    if (this.bindPending) return; // mid-(re)bind — see `bindPending`'s own comment
    if (this.isSockPathOurs()) return;
    log('hooks', 'warn', 'hooks.sock replaced/missing — re-binding', { sockPath: this.sockPath });
    if (!this.toastSentForIncident) {
      this.toastSentForIncident = true;
      this.sendToast('hook socket was replaced by another app instance — re-bound');
    }
    const old = this.server;
    this.server = null;
    try {
      old.close();
    } catch {
      /* noop */
    }
    this.bind();
  }

  sendToast(text: string): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send('app:toast', text);
    } catch {
      /* window tore down mid-send */
    }
  }

  /** Only remove the socket file if it's still OURS — another instance may
   *  now own this path, and removing it out from under a live owner would
   *  just reproduce this exact bug from the other side.
   *
   *  This can't be a simple "check ownership, then maybe rmSync" guard
   *  around `server.close()`, because `close()` itself already deletes
   *  whatever socket file currently sits at the bound path — by path
   *  string, not by the file's actual identity. Confirmed empirically
   *  (macOS, Node v25.6.1): bind server A at `p`, replace `p` with a
   *  DIFFERENT server B's socket without A's knowledge, then call
   *  `A.close()` — B's socket file is deleted too, even though A never
   *  touched `p` again after B rebound it. A `rmSync` guarded on ownership
   *  is powerless against that: the unlink already happened inside
   *  `close()`, before any guard of ours runs. So when the path isn't ours,
   *  the foreign file is moved aside before closing and restored once
   *  `close()`'s callback confirms the handle is actually gone — the only
   *  way to let our own handle release its file descriptor without
   *  destroying whatever another instance is now serving from that name. */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    // Snapshotted, NOT re-read off `this.sockIdentity` from inside `finish`
    // below: `this.sockIdentity` is nulled out a couple of lines down, and
    // `isOurs` needs a value to compare against regardless of when it's
    // called. Called BOTH now (to decide whether to protect the file before
    // closing) and again inside `finish` (to decide whether to actually
    // delete it) — the second call matters even against the exact same
    // identity, because a rebind by another instance in between (the same
    // clobber this file exists to fix, just happening to land in this
    // narrow window) must be re-detected against a LIVE `statSync`, not a
    // cached true/false from before `close()` ran.
    const ourIdentity = this.sockIdentity;
    const isOurs = (): boolean => {
      if (!ourIdentity) return false;
      try {
        const st = statSync(this.sockPath);
        return st.dev === ourIdentity.dev && st.ino === ourIdentity.ino;
      } catch {
        return false;
      }
    };
    const srv = this.server;
    this.server = null;
    this.sockIdentity = null;

    let backupPath: string | null = null;
    if (!isOurs()) {
      try {
        if (existsSync(this.sockPath)) {
          backupPath = `${this.sockPath}.pokeharness-stop-${process.pid}`;
          renameSync(this.sockPath, backupPath);
        }
      } catch (e) {
        // Foreign file couldn't be moved aside — `close()` below may still
        // delete it. Nothing further we can do (it isn't ours to touch
        // otherwise), but this must not silently read as "protected".
        backupPath = null;
        log('hooks', 'warn', 'could not protect a foreign socket during stop() — it may be deleted by close()', {
          message: e instanceof Error ? e.message : String(e)
        });
      }
    }

    const finish = (): void => {
      if (backupPath) {
        try {
          if (existsSync(backupPath)) renameSync(backupPath, this.sockPath);
        } catch (e) {
          // Best-effort — if this fails, the foreign instance's own
          // self-heal (checkSocketHealth) will notice its socket is gone
          // and re-bind on its own next check/spawn.
          log('hooks', 'warn', 'could not restore a foreign socket after stop()', {
            message: e instanceof Error ? e.message : String(e)
          });
        }
        return;
      }
      // Re-check NOW, not the value from before `close()` was called — see
      // this method's own header.
      try {
        if (isOurs() && existsSync(this.sockPath)) rmSync(this.sockPath);
      } catch {
        /* noop */
      }
    };

    // `finish` runs SYNCHRONOUSLY right after `close()`, not as its
    // callback: `stop()` is called from index.ts's `before-quit`, and
    // Electron proceeds to quit as soon as that handler returns — the event
    // loop isn't guaranteed to turn again, so a callback deferred to the
    // 'close' event could simply never fire and leave a foreign socket
    // stranded at its `.pokeharness-stop-<pid>` backup path forever. Verified
    // this is safe (not just assumed): a standalone harness test drove
    // `close()` immediately followed by the rename-back with ZERO event-loop
    // ticks in between (no `await`/`setTimeout` between the `stop()` call and
    // asserting the foreign file survived, unchanged, and still serving
    // connections) — the OS-level unlink `close()` triggers is not something
    // this needs to wait for a callback to observe.
    try {
      srv?.close();
    } catch {
      /* noop */
    }
    finish();
  }

  /** Absolute, quoted `<launcher> <shim>` command for a settings hook entry.
   *  Quoted because userData may contain spaces and this string runs via
   *  `sh -c`. */
  private hookCommand(): string {
    return `"${this.launcherFile}" "${this.shimFile}"`;
  }

  /** Same shape as `hookCommand()` above but for the codex-flavored shim, and
   *  public: unlike the claude one (only ever used from `prepareSession`
   *  below), this is consumed from codexHooks.ts, outside this class — that
   *  file owns merging codex's own `hooks.json`, but reuses this class's
   *  already-solved bundled-node launcher (see HOOK_SHIM's own header for
   *  why a plain `node "<script>"` command isn't reliable here) rather than
   *  re-deriving it. */
  codexHookCommand(): string {
    return `"${this.launcherFile}" "${this.codexShimFile}"`;
  }

  /** Same shape again, for the delegate CLI (first-class delegate sessions) —
   *  the exact command an orchestrator runs, via its own Bash tool, to spawn
   *  a delegate: `<this> --cwd <path> [--label <text>] [--effort <level>]
   *  <prompt>`. Public for the same reason `codexHookCommand` is: nothing
   *  inside this class ever invokes it directly (unlike `hookCommand`, wired
   *  automatically into every claude session's settings), so a caller outside
   *  it needs the string — here, only for surfacing the invocation to a human
   *  (no settings file references this one). */
  delegateCliCommand(): string {
    return `"${this.launcherFile}" "${this.delegateCliFile}"`;
  }

  /** Per-session Claude Code settings routing every wired hook through the
   *  shim. Written fresh on every spawn so a code change here always takes
   *  effect without a stale file lingering from a previous run.
   *
   *  `extraAllowRules` (Arceus v2 — pty.ts's `spawn()` passes
   *  `POKE_TOOL_PERMISSION_RULES` for an Arceus spawn only) adds
   *  `permissions.allow` entries so auto-mode-off doesn't stall a session on
   *  an unattended permission prompt for a Bash command it's expected to run
   *  autonomously. */
  prepareSession(agentId: string, tmpDir: string, extraAllowRules?: string[]): string {
    mkdirSync(tmpDir, { recursive: true });
    const settingsPath = join(tmpDir, `hook-settings-${agentId}.json`);
    const cmd = this.hookCommand();
    const entry = (matcher?: string): { matcher?: string; hooks: { type: string; command: string }[] } => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    const settings = {
      hooks: {
        SessionStart: [entry()],
        UserPromptSubmit: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        Notification: [entry()],
        Stop: [entry()],
        // Wired, but not relied on: confirmed against real transcripts that
        // Claude Code's Agent/Task tool dispatches every subagent
        // asynchronously and delivers completion via an internal message
        // that never reaches ANY hook (not SubagentStop, not even
        // UserPromptSubmit for the injected notification) — see
        // hookRouter.ts's SubagentStop case and BattleManager.ts's file
        // header for the fallback this app actually uses.
        SubagentStop: [entry()],
        // Phase 8.5 Wave B item 4 — fires just before a compaction; the
        // post-compact SessionStart (source: 'compact') that follows is
        // already covered by the SessionStart entry above.
        PreCompact: [entry()]
      },
      // Arceus v2 — omitted entirely (not even an empty array) for every
      // ordinary session, same "untouched unless opted into" posture as
      // `statusLine` below.
      ...(extraAllowRules && extraAllowRules.length > 0
        ? { permissions: { allow: extraAllowRules } }
        : {}),
      // BACKLOG "next up" item 2 — only added when the user opts in
      // (settings → terminal → "hide claude statusline"); when off this key
      // is omitted entirely so the file is byte-identical to before this
      // feature existed and a session inherits `~/.claude/settings.json`'s
      // own `statusLine` exactly as today (CLI-flag settings win over user
      // settings, so an omitted key here is what "untouched" requires).
      // `command: ":"` — the POSIX shell no-op builtin — exits 0 and writes
      // nothing to stdout. Deliberately `:` and not `true`: Claude Code's
      // docs don't document the shell environment `statusLine.command` runs
      // under, and this app's own HOOK_SHIM above needed a PATH workaround
      // because Claude invokes ITS shell commands via a bare `sh -c` with a
      // stripped PATH — `true` is only guaranteed to resolve if `/usr/bin`
      // (or wherever it lives) is on that PATH, while `:` is a POSIX
      // "special builtin" every conforming shell must implement with no
      // external binary lookup, so it can't fail to resolve. Per Claude
      // Code's docs (Troubleshooting: "Scripts that exit with non-zero
      // codes or produce no output cause the status line to go blank"), a
      // no-output command leaves the row blank rather than erroring — this
      // is documented as the failure-mode behavior, not a formal "disable"
      // API, so it's correct by observation rather than by contract. The
      // row itself still reserves its line and the footer's keyboard-hint
      // text (`esc to interrupt`, `? for shortcuts`, `hold space to speak`)
      // still collapses the way it does for any configured `statusLine` —
      // that's a real, documented side effect of setting this key at all,
      // not something an empty command avoids.
      ...(this.hideStatusline ? { statusLine: { type: 'command', command: ':' } } : {})
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return settingsPath;
  }

  /** Set from `appSettings.hideClaudeStatusline` at boot and on every
   *  settings save (main/index.ts) — read by the next `prepareSession` call,
   *  so it only affects sessions spawned/respawned after the toggle changes
   *  (existing ptys keep whatever they launched with, per spec). */
  setHideStatusline(hide: boolean): void {
    this.hideStatusline = hide;
  }

  /** Best-effort teardown of a session's generated settings file. */
  cleanupSession(agentId: string, tmpDir: string): void {
    try {
      const p = join(tmpDir, `hook-settings-${agentId}.json`);
      if (existsSync(p)) rmSync(p);
    } catch {
      /* noop */
    }
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.harness_agent_id ?? undefined;
    const eventName = p.hook_event_name ?? 'Unknown';
    if (!agentId) {
      // No known harness session on this payload — either a genuinely
      // unrelated hook firing (dropped, as before this feature existed) or
      // an external-codex-delegate run (POKEHARNESS_AGENT_ID is never set
      // on those, by definition — see this file's header). Delegate
      // identity travels via the separate `harness_delegate_*` fields the
      // shim stamps above, so it's handled on its own path rather than
      // falling through the ordinary agentId-keyed logic below.
      this.handleDelegate(p, eventName);
      return {};
    }
    this.onRawPayload?.(agentId, p.transcript_path, p.hook_event_name, p.agent_id);
    if (!isKnownHookEvent(eventName)) return {};

    const tool = normalizeToolName(p.tool_name);
    const event: HookEvent = {
      agentId,
      event: eventName,
      tool,
      toolTarget: toolTargetFromInput(tool, p.tool_input),
      notificationType: p.notification_type,
      message: p.message,
      source: p.source,
      claudeSessionId: p.session_id,
      toolUseId: p.tool_use_id,
      subagentType: subagentTypeFromInput(tool, p.tool_input),
      agent_id: p.agent_id,
      agent_type: p.agent_type
    };
    const wc = this.getWebContents();
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send(`hooks:event:${agentId}`, event);
      } catch {
        /* window tore down mid-send */
      }
    }
    // Never gate/deny — this app's hooks are observation-only.
    return {};
  }

  /** External-codex-delegate feature — routes a delegate's SessionStart/Stop
   *  to the renderer on its own `hooks:delegate` channel, deliberately never
   *  `hooks:event:<agentId>`: that channel is the PARENT's own hook stream
   *  (hookRouter.ts's SessionStart/Stop cases reset its status/tool display
   *  and, for Stop, end its real battles), and a delegate landing there
   *  would corrupt it exactly the way BACKLOG's "subagent events on the
   *  parent's channel" watch item describes for Claude subagents. Also never
   *  calls `onRawPayload` — that registers a transcript path against the
   *  named agentId's cost/context HUD (costWatcher.ts), and a delegate has
   *  no agentId of its own to register under; using the PARENT's id would
   *  wrongly attribute the codex transcript to the parent's HUD. */
  private handleDelegate(p: HookPayload, eventName: string): void {
    const parentId = p.harness_delegate_parent ?? undefined;
    if (!parentId) return; // a genuinely unrelated hook firing — drop silently
    if (eventName !== 'SessionStart' && eventName !== 'Stop') {
      // Every other delegate event (PreToolUse, PostToolUse, Notification,
      // ...) is a logged no-op, never routed anywhere — item 3's guard.
      log('hooks', 'info', 'delegate hook event dropped (not SessionStart/Stop)', {
        parentId,
        event: eventName
      });
      return;
    }
    if (!this.isKnownSession?.(parentId)) {
      log('hooks', 'warn', 'delegate hook event — unknown/dead parent session, dropped', {
        parentId,
        event: eventName
      });
      return;
    }
    const label = p.harness_delegate_label?.trim() || 'codex delegate';
    // Codex's own hook payload field name for this IS `session_id`, same as
    // Claude's — confirmed against codex's generated JSON schemas (openai/
    // codex @ 0.150.1, codex-rs/hooks/schema/generated/session-start.command.
    // input.schema.json and stop.command.input.schema.json both require it),
    // resolving the "UNVERIFIED, assumed by analogy" caveat this comment used
    // to carry (see CODEX_HOOK_SHIM's own header in this file, and
    // codexHooks.ts, for the fuller citation). The parent+label fallback
    // below is kept as defensive code — `session_id` is a required field on
    // every codex hook payload per that schema, so in practice this branch
    // is provably unreachable against a spec-conforming codex build, but
    // costs nothing to keep for a payload this app hasn't itself captured
    // live (still true — see this file's constraints).
    const codexSessionId = p.session_id?.trim() || `delegate:${parentId}:${label}`;
    const signal: DelegateHookSignal = { parentId, event: eventName, codexSessionId, label };
    const wc = this.getWebContents();
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send('hooks:delegate', signal);
      } catch {
        /* window tore down mid-send */
      }
    }
  }

  /** Single dispatch point for every UDS connection's one parsed line — ASYNC
   *  (Arceus v2, docs/arceus-v2-plan.md §3.4's "the socket handler must
   *  become async" plumbing note), unlike every individual handler below,
   *  which stays synchronous: none of `handle`/`handleDelegateSpawn`/the
   *  three `handlePoke*` methods actually needs to await anything (a picker
   *  push, a `ptyManager.spawn()` call, and an `InjectionQueue.submit` are
   *  all synchronous), but making the call site itself `async` means one
   *  landing here later that DOES need to await something (a future poke-*
   *  tool, say) is a one-line change, not a second refactor of this whole
   *  dispatch path. */
  private async dispatch(parsed: unknown): Promise<unknown> {
    try {
      // First-class delegate sessions / Arceus v2's three poke-* tools —
      // all distinguished from an ordinary `HookPayload` by `type`, a field
      // no real Claude/codex hook payload ever carries (see
      // shared/delegateSpawn.ts's header).
      if (isDelegateSpawnRequest(parsed)) return this.handleDelegateSpawn(parsed);
      if (isPokeAskRequest(parsed)) return this.handlePokeAsk(parsed);
      if (isPokeSpawnRequest(parsed)) return this.handlePokeSpawn(parsed);
      if (isPokeRelayRequest(parsed)) return this.handlePokeRelay(parsed);
      return this.handle(parsed as HookPayload);
    } catch (e) {
      console.error('[hooks] handler threw:', e);
      return {};
    }
  }

  /** Arceus v2 guard, shared by all three `handlePoke*` methods below —
   *  rejects any request whose `parentAgentId` isn't ARCEUS_SESSION_ID.
   *  `parentAgentId` is read off `POKEHARNESS_AGENT_ID`, the SAME trusted
   *  env var poke-delegate's own identity already relies on (see this
   *  file's header): a discoverability boundary, not real sandboxing — any
   *  same-user process could set that env var itself or write the raw
   *  socket payload directly, exactly as true for poke-delegate today. This
   *  guard's actual job is stopping an honest-but-confused ordinary session
   *  (e.g. a poke-spawned worker that happens to have some copy of this
   *  code) from accidentally reaching a tool meant only for Arceus, not
   *  defending against a hostile one. */
  private isFromArceus(parentAgentId: string | undefined): boolean {
    return parentAgentId === ARCEUS_SESSION_ID;
  }

  private handlePokeAsk(req: PokeAskRequest): PokeToolResponse {
    if (!this.isFromArceus(req.parentAgentId)) return { ok: false, error: 'only arceus can use poke-ask' };
    const question = req.question?.trim();
    const options = (req.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!question) return { ok: false, error: 'a question is required' };
    if (options.length === 0) return { ok: false, error: 'at least one option is required' };
    if (!this.onPokeAsk) return { ok: false, error: 'poke-ask is not wired' };
    return this.onPokeAsk({ ...req, question, options });
  }

  private handlePokeSpawn(req: PokeSpawnRequest): PokeToolResponse {
    if (!this.isFromArceus(req.parentAgentId)) return { ok: false, error: 'only arceus can use poke-spawn' };
    const workspace = req.workspace?.trim();
    const task = req.task?.trim();
    if (!workspace) return { ok: false, error: 'a workspace is required' };
    if (!task) return { ok: false, error: 'an initial task is required' };
    if (!this.onPokeSpawn) return { ok: false, error: 'poke-spawn is not wired' };
    return this.onPokeSpawn({ ...req, workspace, task });
  }

  private handlePokeRelay(req: PokeRelayRequest): PokeToolResponse {
    if (!this.isFromArceus(req.parentAgentId)) return { ok: false, error: 'only arceus can use poke-relay' };
    const agent = req.agent?.trim();
    const message = req.message?.trim();
    if (!agent) return { ok: false, error: 'an agent is required' };
    if (!message) return { ok: false, error: 'a message is required' };
    if (!this.onPokeRelay) return { ok: false, error: 'poke-relay is not wired' };
    return this.onPokeRelay({ ...req, agent, message });
  }

  /** First-class delegate sessions (shared/delegateSpawn.ts) — validates a
   *  `delegate/spawn` request (shape, known parent, existing cwd) and, only
   *  once all three hold, hands off to `onDelegateSpawnRequest` for the
   *  actual spawn. Kept synchronous like `handle()` above: `ptyManager.spawn`
   *  itself is synchronous, so there's no reason to make the UDS caller wait
   *  on anything async (in particular, the renderer catching up — creating
   *  the terminal, adding the roster entry — happens on its own time; see
   *  `DelegateSessionSpawned`'s own header for why that's safe). */
  private handleDelegateSpawn(req: DelegateSpawnRequest): DelegateSpawnResponse {
    const parentAgentId = req.parentAgentId?.trim();
    const cwd = req.cwd?.trim();
    const prompt = req.prompt?.trim();
    if (!parentAgentId || !cwd || !prompt) {
      return { ok: false, error: 'parentAgentId, cwd and prompt are all required' };
    }
    if (!this.isKnownSession?.(parentAgentId)) {
      log('hooks', 'warn', 'delegate spawn request — unknown/dead parent session, rejected', { parentAgentId });
      return { ok: false, error: `unknown parent session: ${parentAgentId}` };
    }
    let isDir = false;
    try {
      isDir = existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { ok: false, error: `cwd does not exist or is not a directory: ${cwd}` };
    }
    if (!this.onDelegateSpawnRequest) {
      // Defensive only — main/index.ts always wires this; a standalone/test
      // construction of this class (see the constructor param's own comment)
      // is the one path that reaches here.
      return { ok: false, error: 'delegate spawning is not wired' };
    }
    return this.onDelegateSpawnRequest({ ...req, parentAgentId, cwd, prompt });
  }
}

/** `delegate/spawn` requests are distinguished from an ordinary `HookPayload`
 *  by this field — no real Claude/codex hook payload ever carries a `type`
 *  key (see shared/delegateSpawn.ts's header). A loose shape check, not a
 *  full schema validation: `handleDelegateSpawn` above does the actual field
 *  validation once this narrows the branch. */
function isDelegateSpawnRequest(value: unknown): value is DelegateSpawnRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'delegate/spawn'
  );
}

/** Arceus v2 — same loose shape-check convention as `isDelegateSpawnRequest`
 *  above; each `handlePoke*` method does the real field validation once this
 *  narrows the branch. */
function isPokeAskRequest(value: unknown): value is PokeAskRequest {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'poke/ask';
}

function isPokeSpawnRequest(value: unknown): value is PokeSpawnRequest {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'poke/spawn';
}

function isPokeRelayRequest(value: unknown): value is PokeRelayRequest {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'poke/relay';
}
