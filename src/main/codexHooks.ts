/**
 * codexHooks.ts — the missing first hop for external-codex-delegate battlers
 * (see hookBridge.ts's `handleDelegate`/`DELEGATE_PARENT_ENV` and BACKLOG's
 * "PLUMBING SHIPPED, FEATURE INERT" entry). Idempotently merges a pokeharness
 * entry into codex's OWN global hook config so a `codex exec` launched with
 * `POKEHARNESS_DELEGATE_PARENT`/`POKEHARNESS_DELEGATE_LABEL` set on it
 * actually invokes pokeharness's hook shim on SessionStart/Stop — until this
 * ran, hookRouter.ts's `onDelegateHookEvent` listener and this app's
 * `handleDelegate` routing were both unreachable code.
 *
 * ---- Codex hooks.json schema ----
 * Verified against openai/codex @ 0.150.1's actual source (not just docs):
 * codex-rs/config/src/hook_config.rs (`HooksFile`, `HookEventsToml`,
 * `MatcherGroup`, `HookHandlerConfig`) and codex-rs/hooks/schema/generated/
 * *.command.{input,output}.schema.json, cross-checked against this machine's
 * own real `~/.codex/hooks.json` + `~/.codex/config.toml`.
 *
 * Top level: `{ "hooks": { "<EventName>": [ MatcherGroup, ... ], ... } }` —
 * `HooksFile` is `#[serde(deny_unknown_fields)]` with only `description` and
 * `hooks` as legal top-level keys, so this module only ever touches `hooks`.
 * Each event's value is an ARRAY of `MatcherGroup` (`{ matcher?: string,
 * hooks: HookHandlerConfig[] }`), so one event can carry several independent
 * command entries side by side — confirmed live: this machine's own file has
 * exactly one MatcherGroup per event (an unrelated third-party tool's), and
 * appending a second MatcherGroup for the same event is exactly how codex
 * expects two tools to coexist. A command handler is `{ type: "command",
 * command: string, timeout?: number (SECONDS, not ms), async?: boolean,
 * ... }` — same `type` discriminator Claude Code's own settings.json hooks
 * use. Confirmed hook events (`HookEventsToml`'s 12 variants): PreToolUse,
 * PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart,
 * SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt
 * — no plain "Notification" (Claude-only), irrelevant here regardless since
 * only SessionStart/Stop are wired (see WIRED_EVENTS below).
 *
 * Payload piped to a hook command's stdin carries `hook_event_name` (a
 * literal string, e.g. "SessionStart") and `session_id` (codex's own
 * ThreadId) as REQUIRED fields — confirmed via session-start.command.input.
 * schema.json / stop.command.input.schema.json. These are the exact field
 * names hookBridge.ts's `HookPayload`/`handleDelegate` already assumed; no
 * fix needed there. What DOES need care is the shim: see hookBridge.ts's
 * `CODEX_HOOK_SHIM` for why this app writes a codex-specific translator
 * rather than reusing the claude one verbatim (confirmed via codex-rs/hooks/
 * src/registry.rs + codex-rs/protocol/src/shell_environment.rs that a hook
 * subprocess DOES inherit the launching `codex exec` process's real
 * environment, unfiltered by codex's separate shell-tool sandboxing policy —
 * so a delegate run launched from inside a harness `claude` pty would leak
 * that pty's own `POKEHARNESS_AGENT_ID` into the codex hook's env too).
 * Headless `codex exec` runs this exact same hook-dispatch code as the
 * interactive TUI (both sit on `codex-core`'s `Session`, codex-rs/core/src/
 * session/session.rs's `Hooks::new` call) — this is not a TUI-only feature.
 *
 * ---- Approval / trust model — the one thing this module deliberately does
 * NOT try to automate ----
 * A merged hooks.json entry is never auto-trusted. Codex hashes each hook
 * handler (event + matcher + command) and only actually RUNS it once a
 * matching `trusted_hash` exists under `[hooks.state]` in config.toml (see
 * codex-rs/hooks/src/engine/discovery.rs: a handler reaches the live
 * dispatch list only when its trust_status is `Managed` or `Trusted` — never
 * `Untrusted`/`Modified`). The ONLY place that writes a `trusted_hash` is the
 * interactive TUI's startup hook-review screen (codex-rs/tui/src/
 * startup_hooks_review.rs: on launch, if any hook for the cwd is
 * Untrusted/Modified, codex shows a blocking "Review hooks / Trust all and
 * continue / Continue without trusting" prompt). Headless `codex exec` has
 * NO such prompt — a hook there either already has a trusted_hash on file,
 * or the invocation passes the global `--bypass-hook-trust` flag (codex-rs/
 * exec/src/cli.rs), or it silently never fires (no error, no log on codex's
 * side — this app would just never see the hook payload).
 *
 * This app never forges a `trusted_hash` — that would defeat the entire
 * point of the mechanism, and it's not this app's config.toml to rewrite
 * uninvited. It merges hooks.json only, logs what it did, and main/index.ts
 * surfaces a one-time in-app notice. Practical upshot: because a delegate
 * ALWAYS launches via headless `codex exec`, the very first delegate run can
 * only fire its hook once the user has separately run at least one ordinary
 * INTERACTIVE `codex` session (any cwd — the trust key is keyed by this
 * file's path + event + index, not by project) and picked "Trust all and
 * continue" on that review screen. See NOTICE_TEXT below for the exact
 * wording surfaced to the user for this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './diagnostics';
import { CODEX_SHIM_FILENAME, type HookBridge } from './hookBridge';

/** Event names merged into codex's hooks.json — deliberately just the two
 *  hookBridge.ts's `handleDelegate` actually consumes. Codex's hooks.json is
 *  GLOBAL (every codex invocation on this machine reads it, not just
 *  pokeharness-launched delegates), so wiring PreToolUse/PostToolUse/etc too
 *  would add a hook subprocess round-trip to every tool call in EVERY codex
 *  session the user ever runs — for events `handleDelegate` already
 *  logs-and-drops as a no-op when they do arrive from a genuine delegate.
 *  Not worth taxing ordinary codex usage for. SessionEnd is deliberately
 *  excluded too even though it pairs conceptually with SessionStart: codex
 *  caps its timeout at 3s (`normalize_command_hook`'s SessionEnd special
 *  case) and it isn't a signal `handleDelegate` reads at all today. */
const WIRED_EVENTS = ['SessionStart', 'Stop'] as const;

function codexHome(): string {
  // Mirrors usageService.ts's own `codexHome` resolution exactly — this app
  // never overrides `CODEX_HOME` for codex's own invocations (that would risk
  // cutting codex off from its own auth/sessions/plugins/trust state, the
  // BACKLOG worry this feature's earlier dispatch flagged); it only ever
  // reads whichever `$CODEX_HOME` codex itself would use, to merge into it.
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export interface EnsureCodexHooksResult {
  /** True only the first time this call actually changed hooks.json on disk
   *  (idempotent — false on every later boot once our entry is already
   *  correct), so main/index.ts can surface the one-time approval notice
   *  exactly once instead of on every launch. */
  changed: boolean;
}

const NOT_CHANGED: EnsureCodexHooksResult = { changed: false };

/** One `HookHandlerConfig::Command` entry, narrowed just enough to find and
 *  compare our own — every other field codex's schema allows (`timeout`,
 *  `async`, ...) is irrelevant here and left alone. */
interface CommandHandler {
  type?: unknown;
  command?: unknown;
}

/** One `MatcherGroup` entry — `{ matcher?, hooks: HookHandlerConfig[] }`. */
interface MatcherGroupShape {
  matcher?: unknown;
  hooks?: unknown;
}

function isMatcherGroup(value: unknown): value is MatcherGroupShape & { hooks: unknown[] } {
  return value !== null && typeof value === 'object' && Array.isArray((value as MatcherGroupShape).hooks);
}

function isOwnCommandHandler(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const h = value as CommandHandler;
  return h.type === 'command' && typeof h.command === 'string' && h.command.includes(CODEX_SHIM_FILENAME);
}

function isOurOwnGroup(group: unknown): group is MatcherGroupShape & { hooks: unknown[] } {
  return isMatcherGroup(group) && group.hooks.some(isOwnCommandHandler);
}

/** Idempotently merge a pokeharness `SessionStart`/`Stop` entry into
 *  `$CODEX_HOME/hooks.json`, preserving every existing entry (another tool's
 *  included) exactly as found. Never clobbers: any shape this module can't
 *  confidently understand (unparseable JSON, a non-object root, a non-array
 *  event value) is logged and left completely untouched rather than guessed
 *  at or overwritten. */
export function ensureCodexHooks(hookBridge: HookBridge): EnsureCodexHooksResult {
  const home = codexHome();
  const path = join(home, 'hooks.json');

  let root: Record<string, unknown> = { hooks: {} };
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      log('codexHooks', 'error', 'could not read hooks.json — leaving it untouched', {
        path,
        error: e instanceof Error ? e.message : String(e)
      });
      return NOT_CHANGED;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log(
        'codexHooks',
        'error',
        'hooks.json is not valid JSON — leaving it untouched; codex delegate hooks will not fire until this is fixed',
        { path, error: e instanceof Error ? e.message : String(e) }
      );
      return NOT_CHANGED;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log('codexHooks', 'error', 'hooks.json root is not a JSON object — leaving it untouched', { path });
      return NOT_CHANGED;
    }
    root = parsed as Record<string, unknown>;
  }

  const hooks = root.hooks;
  if (hooks === undefined) {
    root.hooks = {};
  } else if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    log('codexHooks', 'error', 'hooks.json\'s "hooks" key is not an object — leaving it untouched', { path });
    return NOT_CHANGED;
  }
  const hookEvents = root.hooks as Record<string, unknown>;

  const command = hookBridge.codexHookCommand();
  let changed = false;

  for (const event of WIRED_EVENTS) {
    const existing = hookEvents[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      // Someone/something set this event to a non-array shape codex itself
      // wouldn't accept either — never guess at a rewrite here, just skip
      // this one event and let the log line explain why.
      log('codexHooks', 'error', `hooks.json's "${event}" entry is not an array — leaving it untouched`, { path });
      continue;
    }
    const groups: unknown[] = Array.isArray(existing) ? existing : [];

    // Identify OUR OWN group by the shim filename, not the full command
    // string: the command embeds this install's `userData` path, which
    // differs between a dev and a packaged build (or a reinstall at a new
    // path), so a byte-for-byte match would leave stale duplicate entries
    // behind instead of recognizing "this is still us, just moved".
    const ownIndex = groups.findIndex(isOurOwnGroup);

    if (ownIndex === -1) {
      // Append — never insert/splice before existing groups, so another
      // tool's own group_index (and therefore its already-approved trust
      // hash) never shifts.
      hookEvents[event] = [...groups, { hooks: [{ type: 'command', command }] }];
      changed = true;
      continue;
    }

    const ownGroup = groups[ownIndex] as MatcherGroupShape & { hooks: CommandHandler[] };
    if (ownGroup.hooks.length === 1 && ownGroup.hooks[0]?.command === command) {
      hookEvents[event] = groups; // already correct — write back unchanged
      continue;
    }
    // Our own entry exists but points at a stale path (e.g. a dev vs.
    // packaged build's different userData) — rewrite IN PLACE rather than
    // appending a second copy. This keeps `group_index` stable for every
    // OTHER group in this array (their trust hashes are untouched), while
    // ours picks up a new hash and needs a fresh one-time approval, which is
    // the correct/expected behavior for a hook whose command actually
    // changed.
    const rewritten = [...groups];
    rewritten[ownIndex] = { hooks: [{ type: 'command', command }] };
    hookEvents[event] = rewritten;
    changed = true;
  }

  if (!changed) return NOT_CHANGED;

  try {
    mkdirSync(home, { recursive: true });
    const tmpPath = `${path}.pokeharness-tmp-${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, path);
  } catch (e) {
    log('codexHooks', 'error', 'writing hooks.json failed', { path, error: e instanceof Error ? e.message : String(e) });
    return NOT_CHANGED;
  }

  log(
    'codexHooks',
    'info',
    'merged pokeharness entry into codex hooks.json — codex will ask to approve it once, on the next interactive session',
    { path, events: WIRED_EVENTS }
  );
  return { changed: true };
}

/** Shown once, the first time `ensureCodexHooks` actually changes the file —
 *  see this file's header for why the approval step can't be automated or
 *  skipped, and why it specifically requires an INTERACTIVE codex session
 *  (headless `codex exec`, which is how every delegate launches, has no
 *  review UI of its own). */
export const CODEX_HOOKS_NOTICE_TEXT =
  'pokéharness added a hook to codex — next time you open an interactive codex session, choose "trust all and continue" so delegate battlers can spawn';
