/**
 * UsageService — in-app provider usage-limits panel (BACKLOG "next up" item
 * 1). Reads Claude/Codex's OWN stored CLI credential to call their usage
 * endpoints, read-only, ONLY while `AppSettings.usageLimitsEnabled` is true
 * (see appSettingsTypes.ts). This is a hard product guarantee, not a nice-
 * to-have: `setEnabled(false)` clears the poll timer and every piece of
 * in-memory state that could drive another credential read; nothing in this
 * file's fetch/read paths runs except from inside `pollAll`, and `pollAll`
 * itself is the very first thing that returns early when `this.enabled` is
 * false. No credential is ever written, refreshed, or sent anywhere but the
 * documented usage endpoint host; no CLI is ever spawned.
 *
 * Endpoint/credential shapes, gauge-mapping rules, and every hard constraint
 * below (429 gate, "decode leniently", "hide the row never crash", the
 * account-attribute caveat) come straight from docs/usage-limits-research.md
 * — see that file for the primary-source citations (CodexBar, openai/codex,
 * ccusage). Cursor is intentionally absent: no viable individual usage
 * endpoint without cookie-scraping (research doc §3).
 *
 * Push model mirrors costWatcher.ts: a `webContents.send('usage:snapshot',
 * …)` on every poll, one authoritative UsageSnapshot at a time (not a delta
 * per provider) — simpler for the renderer to reason about, and the payload
 * is tiny (a handful of percentages).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WebContents } from 'electron';
import { log } from './diagnostics';
import type {
  UsageProviderId,
  UsageProviderSnapshot,
  UsageProviderState,
  UsageSnapshot,
  UsageWindow
} from '../shared/usageTypes';

const execFileAsync = promisify(execFile);

/** Background poll cadence while the toggle is on — "self-throttle: poll at
 *  most every 5 min in background" (task spec). */
const POLL_MS_BACKGROUND = 5 * 60_000;
/** Popover-open-triggered refresh throttle — "refresh on popover open at
 *  most once/min" (task spec). */
const MANUAL_REFRESH_MIN_INTERVAL_MS = 60_000;
/** Fallback 429 gate length when a Retry-After header is present but
 *  unparseable, or absent entirely on a 429 (shouldn't happen, but the
 *  research doc's "never hammer this endpoint" rule needs SOME gate even
 *  then). */
const DEFAULT_RATE_LIMIT_GATE_MS = 60_000;
/** How far back to look for a Codex rollout log carrying a `rate_limits`
 *  snapshot — research doc: "lookback up to ~7 days". */
const CODEX_LOOKBACK_DAYS = 7;
/** Only the tail of a rollout file needs scanning — we want the MOST RECENT
 *  matching event, and rollout files are append-only, so the tail is where
 *  it lives. Bounds memory on a very long-running session's log. */
const CODEX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Fallback UA when we can't know the real CLI's own version string — same
 *  fallback CodexBar itself uses (research doc). */
const CLAUDE_USER_AGENT = 'claude-code/2.1.0';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Every provider id this service knows how to poll — the default "nothing
 *  excluded" set, and what `setExcludedProviders` below diffs the persisted
 *  `AppSettings.usageExcludedProviders` list against (feedback: "let the
 *  user pick which providers to include"). */
const ALL_USAGE_PROVIDERS: UsageProviderId[] = ['claude', 'codex'];

// ─── Shared helpers ─────────────────────────────────────────────────────────

function clampPercent(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** ISO-8601 (Claude) or epoch-seconds (Codex, passed pre-multiplied by the
 *  caller) → epoch ms, or null on anything unparseable — every timestamp
 *  field is optional per the research doc's "decode leniently" rule. */
function isoToMs(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Thrown by the network fetchers so callers can distinguish a 401
 *  (unauthorized — token rotated/revoked out from under us) from every
 *  other failure without re-parsing an error string. */
class HttpStatusError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Retry-After can be either delta-seconds or an HTTP-date (RFC 9110 §10.2.3)
 *  — handle both, per the research doc's "honor Retry-After (seconds or
 *  HTTP-date)" instruction. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_GATE_MS;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return DEFAULT_RATE_LIMIT_GATE_MS;
}

// ─── Claude ──────────────────────────────────────────────────────────────

interface ClaudeOAuthCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // ms since epoch
  scopes?: string[];
  rateLimitTier?: string;
  subscriptionType?: string;
}

/** Keychain query-by-service-only (account attribute unconfirmed — research
 *  doc §1), file fallback second. Never writes anything, never touches the
 *  refresh token. Returns null on any failure — a missing/unreadable
 *  credential is just "no data", not a crash. */
async function readClaudeCredential(): Promise<ClaudeOAuthCredential | null> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 }
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    const cred = (parsed as { claudeAiOauth?: ClaudeOAuthCredential } | null)?.claudeAiOauth;
    if (cred && typeof cred === 'object') return cred;
  } catch {
    // Not in keychain (headless/CI, or this Mac's Claude Code never logged
    // in via keychain) — fall through to the file fallback below.
  }
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
    const raw = await readFile(join(configDir, '.credentials.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const cred = (parsed as { claudeAiOauth?: ClaudeOAuthCredential } | null)?.claudeAiOauth;
    if (cred && typeof cred === 'object') return cred;
  } catch {
    // No file either — genuinely no credential available.
  }
  return null;
}

/** Every field optional per the research doc — this whole shape is a best-
 *  effort decode of an undocumented, reverse-engineered response. */
interface ClaudeUsageWindowRaw {
  utilization?: number;
  resets_at?: string;
}
interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindowRaw;
  seven_day?: ClaudeUsageWindowRaw;
  seven_day_oauth_apps?: ClaudeUsageWindowRaw;
  seven_day_sonnet?: ClaudeUsageWindowRaw;
  seven_day_opus?: ClaudeUsageWindowRaw;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number;
    currency?: string;
  };
  limits?: Array<{
    percent?: number;
    resets_at?: string;
    scope?: { model?: { id?: string; display_name?: string } };
    group?: string;
    kind?: string;
  }>;
}

/** Whether two `resetsAt` values (both epoch-ms-or-null) genuinely conflict
 *  — i.e. both are known timestamps more than a minute apart. A restatement
 *  entry in `limits[]` can legitimately OMIT `resets_at` entirely (every
 *  field here is optional per the research doc's "decode leniently" rule) —
 *  root cause of a prior duplicate-row miss: the old check treated "one side
 *  null, the other a real timestamp" as a mismatch, which let a session/
 *  weekly restatement that simply doesn't repeat the reset time render as a
 *  second row. Only two DIFFERING known timestamps count as a real conflict
 *  now; a missing timestamp on either side is not evidence of anything. */
function resetsConflict(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) >= 60_000;
}

/** CodexBar's `mapOAuthUsage` gauge-mapping rules (research doc §1), ported
 *  1:1: 5h fallback chain, weekly always from `seven_day` alone, one
 *  model-scoped card, `limits[]` additive (never filtered on `is_active`),
 *  and — only when every flat window is absent — a synthesized spend gauge
 *  from `extra_usage` (cents). Never throws: every access is optional-
 *  chained, so an unrecognized/reshuffled response just yields fewer (or
 *  zero) windows rather than crashing the poll. */
function mapClaudeUsage(data: ClaudeUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const fiveHour =
    data.five_hour ?? data.seven_day ?? data.seven_day_oauth_apps ?? data.seven_day_sonnet ?? data.seven_day_opus;
  // When `five_hour` itself is absent, the fallback chain can resolve to the
  // SAME object `data.seven_day` — faithful to the research doc's mapping,
  // but rendering it a second time under the '7d' label below would show two
  // identical bars with different names, which reads as a bug rather than a
  // deliberate fallback. Skip the 5h row in that one case; '7d' still shows
  // the real number.
  if (typeof fiveHour?.utilization === 'number' && fiveHour !== data.seven_day) {
    windows.push({ label: '5h', usedPercent: clampPercent(fiveHour.utilization), resetsAt: isoToMs(fiveHour.resets_at) });
  }

  if (typeof data.seven_day?.utilization === 'number') {
    windows.push({
      label: '7d',
      usedPercent: clampPercent(data.seven_day.utilization),
      resetsAt: isoToMs(data.seven_day.resets_at)
    });
  }

  const modelCard = data.seven_day_sonnet ?? data.seven_day_opus;
  if (typeof modelCard?.utilization === 'number') {
    const label = data.seven_day_sonnet ? '7d sonnet' : '7d opus';
    windows.push({ label, usedPercent: clampPercent(modelCard.utilization), resetsAt: isoToMs(modelCard.resets_at) });
  }

  // `limits[]` is additive per the research doc, but in practice its entries
  // frequently just restate a window already rendered above under a
  // different label — e.g. a "session"/"weekly" alias for `five_hour`/
  // `seven_day` (user-reported duplicate rows: "5h 75%" AND "session 75%").
  // A model-scoped entry (`scope.model.display_name` present, e.g. the
  // "Fable" promotional window) is NEVER treated as a restatement even if it
  // happens to share both signals below — early in a shared weekly window
  // every model-scoped card can read the same 0%/same reset as the plain
  // '7d' row, and that row must still render (it's real and distinct, not a
  // duplicate). For everything else, a restatement is detected two ways:
  //  1. `kind` names the window it restates directly ("session" → the '5h'
  //     row, "weekly" → the '7d' row — research doc: "5h session =
  //     `five_hour`") — the strongest signal, and the same field this
  //     function already trusts enough to use as user-visible label text
  //     below, so it costs no new trust.
  //  2. Otherwise, percent round-matches an already-rendered window AND the
  //     two reset times don't outright conflict (`resetsConflict` — a
  //     restatement entry can legitimately omit `resets_at`, so a missing
  //     timestamp on either side is never treated as a conflict, only two
  //     differing known timestamps are).
  for (const limit of data.limits ?? []) {
    if (typeof limit?.percent !== 'number') continue;
    const resetsAt = isoToMs(limit.resets_at);
    const usedPercent = clampPercent(limit.percent);
    const modelName = limit.scope?.model?.display_name;
    const kind = limit.kind?.toLowerCase() ?? '';
    const isRestatement =
      !modelName &&
      ((kind.includes('session') && windows.some((w) => w.label === '5h')) ||
        (kind.includes('weekly') && windows.some((w) => w.label === '7d')) ||
        windows.some(
          (w) => Math.round(w.usedPercent) === Math.round(usedPercent) && !resetsConflict(w.resetsAt, resetsAt)
        ));
    if (isRestatement) continue;
    const name = (modelName || limit.kind || 'limit').toLowerCase();
    // Only the one confirmed shape (research doc: `group: "weekly"` on the
    // "Fable" example) gets the "7d " scope prefix — matching the 7d/7d
    // sonnet/7d opus convention above without guessing at an unconfirmed
    // 5h-scoped limits[] shape.
    const label = limit.group === 'weekly' ? `7d ${name}` : name;
    windows.push({ label, usedPercent, resetsAt });
  }

  // Credit/extra-usage balance (user request: "add credit usage if
  // applicable") — present whenever `extra_usage.is_enabled`, ADDITIONALLY
  // to whatever rate-limit windows above (previously this only synthesized
  // when every other window was absent, matching CodexBar's "no rate-limit
  // data at all" fallback case — but a credits balance is informative even
  // when 5h/7d windows ARE present, so it's no longer gated on that). Marked
  // via `spend` so the renderer's tightest-window/chip-tone logic (which
  // drives the topbar chip) can exclude it — this is a spend balance, not a
  // rate limit, and shouldn't hijack the chip's "how close to a real limit"
  // meaning. Absent entirely when `extra_usage` isn't present/enabled — no
  // placeholder row.
  if (data.extra_usage?.is_enabled && typeof data.extra_usage.utilization === 'number') {
    const eu = data.extra_usage;
    windows.push({
      label: 'credits',
      usedPercent: clampPercent(eu.utilization),
      resetsAt: null,
      spend: {
        usedCents: typeof eu.used_credits === 'number' ? eu.used_credits : 0,
        limitCents: typeof eu.monthly_limit === 'number' ? eu.monthly_limit : 0,
        currency: eu.currency || 'USD'
      }
    });
  }

  return windows;
}

function claudeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': CLAUDE_USER_AGENT
  };
}

// ─── Codex ───────────────────────────────────────────────────────────────

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // epoch seconds (rollout-log shape)
}
interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/** `slot` is the label's DEFAULT (primary is always the 5h window, secondary
 *  always the weekly one, per every example payload in the research doc) —
 *  `window_minutes` only overrides it when actually present. `window_minutes`
 *  is optional (research doc: schema has changed at least once), so relying
 *  on it alone would collapse both windows to the SAME label ('7d', since
 *  `undefined <= 720` is false) whenever it's missing from both — duplicate
 *  React keys and a display that lies about which window is which. '7d' (not
 *  'wk') to match Claude's own weekly-window label — same popover, same
 *  convention, so a provider swap in the panel doesn't flip label style. */
function codexWindowLabel(slot: 'primary' | 'secondary', windowMinutes: number | undefined): string {
  if (typeof windowMinutes === 'number') return windowMinutes <= 720 ? '5h' : '7d';
  return slot === 'primary' ? '5h' : '7d';
}

function mapCodexRateLimits(rl: CodexRateLimits): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (typeof rl.primary?.used_percent === 'number') {
    windows.push({
      label: codexWindowLabel('primary', rl.primary.window_minutes),
      usedPercent: clampPercent(rl.primary.used_percent),
      resetsAt: typeof rl.primary.resets_at === 'number' ? rl.primary.resets_at * 1000 : null
    });
  }
  if (typeof rl.secondary?.used_percent === 'number') {
    windows.push({
      label: codexWindowLabel('secondary', rl.secondary.window_minutes),
      usedPercent: clampPercent(rl.secondary.used_percent),
      resetsAt: typeof rl.secondary.resets_at === 'number' ? rl.secondary.resets_at * 1000 : null
    });
  }
  return windows;
}

/** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, newest-mtime-first, over
 *  the last CODEX_LOOKBACK_DAYS calendar days — matches the exact path shape
 *  the research doc confirms from openai/codex HEAD. */
async function collectRecentRolloutFiles(sessionsDir: string): Promise<string[]> {
  const candidates: { path: string; mtime: number }[] = [];
  const now = new Date();
  for (let i = 0; i < CODEX_LOOKBACK_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayDir = join(
      sessionsDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    );
    let entries: string[];
    try {
      entries = await readdir(dayDir);
    } catch {
      continue; // no sessions that day
    }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dayDir, name);
      try {
        const st = await stat(path);
        candidates.push({ path, mtime: st.mtimeMs });
      } catch {
        // Vanished between readdir and stat — skip.
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.map((c) => c.path);
}

/** Reads only the tail of a (possibly large, append-only) rollout file —
 *  the newest `token_count` event, if any, lives at the end. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const st = await stat(path);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Scans one rollout file's tail, newest-line-first, for the latest
 *  `{"type":"event_msg","payload":{"type":"token_count",...,"rate_limits":…}}`
 *  with non-null `rate_limits` — reliability caveat from the research doc
 *  (openai/codex#14880/#14728: sometimes null even interactively), so a
 *  miss here just means "keep looking at older files/the network fallback",
 *  not an error. */
async function findLatestRateLimits(path: string): Promise<CodexRateLimits | null> {
  let content: string;
  try {
    content = await readTail(path, CODEX_ROLLOUT_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; payload?: { type?: string; rate_limits?: CodexRateLimits } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn line (tail cut mid-record, or a write in flight) — skip
    }
    if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.rate_limits) {
      return entry.payload.rate_limits;
    }
  }
  return null;
}

async function tryCodexRolloutLogs(codexHome: string): Promise<UsageWindow[] | null> {
  const sessionsDir = join(codexHome, 'sessions');
  const files = await collectRecentRolloutFiles(sessionsDir);
  for (const file of files) {
    const rl = await findLatestRateLimits(file);
    if (rl) {
      const windows = mapCodexRateLimits(rl);
      if (windows.length > 0) return windows;
    }
  }
  return null;
}

async function readCodexAuth(codexHome: string): Promise<CodexAuthFile | null> {
  try {
    const raw = await readFile(join(codexHome, 'auth.json'), 'utf8');
    return JSON.parse(raw) as CodexAuthFile;
  } catch {
    return null;
  }
}

/** `chatgpt_account_id` JWT claim (research doc: recoverable when
 *  `tokens.account_id` is missing) — manual base64url decode of the JWT
 *  payload segment only, no signature verification (we're not authenticating
 *  anything, just reading a claim off our own already-trusted local token to
 *  fill an optional request header). */
function accountIdFromJwt(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload: unknown = JSON.parse(json);
    const id = (payload as { chatgpt_account_id?: unknown })?.chatgpt_account_id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

interface CodexUsageWindowRaw {
  used_percent?: number;
  reset_at?: number; // epoch seconds
  limit_window_seconds?: number;
}
interface CodexNetworkUsageResponse {
  rate_limit?: {
    primary_window?: CodexUsageWindowRaw;
    secondary_window?: CodexUsageWindowRaw;
  };
  /** Plan-level credit balance (research doc §2 sample response) — no known
   *  maximum in the response, so unlike Claude's `extra_usage` this can't be
   *  rendered as a gauge; surfaced as a plain balance row instead (see
   *  `balanceOnly` on UsageWindow). `balance`'s unit is UNVERIFIED — the
   *  research doc's only sample (`"balance": 40.5`) doesn't say whether it's
   *  dollars or another unit, so it's rendered as-is rather than assuming a
   *  cents scale like Claude's fields. */
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number;
  };
}

function mapCodexNetworkUsage(data: CodexNetworkUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const toWindow = (slot: 'primary' | 'secondary', w: CodexUsageWindowRaw | undefined): UsageWindow | null => {
    if (typeof w?.used_percent !== 'number') return null;
    const windowMinutes = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : undefined;
    return {
      label: codexWindowLabel(slot, windowMinutes),
      usedPercent: clampPercent(w.used_percent),
      resetsAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null
    };
  };
  const primary = toWindow('primary', data.rate_limit?.primary_window);
  if (primary) windows.push(primary);
  const secondary = toWindow('secondary', data.rate_limit?.secondary_window);
  if (secondary) windows.push(secondary);

  // Credit balance (user request: "add credit usage if applicable") — only
  // when the account actually has a (non-unlimited) balance to report; a
  // `false`/absent `has_credits`, an `unlimited` account, or a missing
  // `balance` number all mean "nothing to show", not a zero/placeholder row.
  const credits = data.credits;
  if (credits?.has_credits === true && credits.unlimited !== true && typeof credits.balance === 'number') {
    windows.push({
      label: 'credits',
      usedPercent: 0, // meaningless for a balanceOnly row — no known max to compute against
      resetsAt: null,
      balanceOnly: true,
      balanceText: `${credits.balance} credits remaining`
    });
  }
  return windows;
}

async function fetchCodexNetworkUsage(auth: CodexAuthFile): Promise<CodexNetworkUsageResponse> {
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) throw new Error('codex: no access token');
  const accountId = auth.tokens?.account_id || accountIdFromJwt(auth.tokens?.id_token) || accountIdFromJwt(accessToken);
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await fetch(CODEX_USAGE_URL, { headers });
  if (res.status === 401) throw new HttpStatusError(401, 'codex usage endpoint: unauthorized');
  if (!res.ok) throw new HttpStatusError(res.status, `codex usage endpoint: http ${res.status}`);
  return (await res.json()) as CodexNetworkUsageResponse;
}

// ─── Service ────────────────────────────────────────────────────────────

interface LastGood {
  windows: UsageWindow[];
  updatedAt: number;
}

export class UsageService {
  private enabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: UsageSnapshot = { enabled: false, providers: [], updatedAt: 0 };
  private lastManualRefresh = 0;
  /** In-flight poll guard — `refreshNow` and the background timer can
   *  otherwise race two concurrent `pollAll` calls. */
  private polling: Promise<void> | null = null;

  // Claude 429-gate + "don't hammer a dead token" state (feedback: keep
  // retrying a locally-valid-but-server-rejected token forever is exactly
  // the hammering the research doc's 429 rule warns against, just for 401
  // instead of 429 — so this mirrors that gate for the unauthorized case).
  private claudeGatedUntil = 0;
  private claudeUnauthorizedToken: string | null = null;
  private claudeLastGood: LastGood | null = null;

  private codexUnauthorizedToken: string | null = null;

  /** Which providers are actually polled — the complement of the persisted
   *  `AppSettings.usageExcludedProviders` list. Defaults to every known
   *  provider so a fresh install / never-saved settings sees no behavior
   *  change. Set from main/index.ts on boot and every settings save, same
   *  call sites as `setEnabled` below — see `setExcludedProviders`. */
  private includedProviders: Set<UsageProviderId> = new Set(ALL_USAGE_PROVIDERS);

  constructor(private getWebContents: () => WebContents | null) {}

  /** The ONE place credential access turns on/off. Called from main/index.ts
   *  on boot (with the persisted setting) and on every settings save. Toggling
   *  off clears every piece of state a later re-enable would otherwise reuse
   *  stale (the 429 gate, the unauthorized-token locks, cached windows) so a
   *  fresh enable always starts from a clean slate rather than an off/on
   *  cycle's own state leaking into a new session's behavior. */
  setEnabled(next: boolean): void {
    if (next === this.enabled) return;
    this.enabled = next;
    // Reset on BOTH transitions, not just off→on: a poll that was already
    // in flight when the user flipped the toggle off can still resolve
    // afterwards (fetchClaude/fetchCodex write their own gate/lock/cache
    // fields as soon as their `fetch()` awaits — before pollAll's own
    // post-await `enabled` re-check runs) and land stale values into these
    // fields even though the SNAPSHOT that poll produced was correctly
    // discarded (see pollAll's own comment). Clearing here on every
    // transition means neither a same-session re-enable nor this residual
    // write can carry stale gate/lock state into a fresh on-period.
    this.claudeGatedUntil = 0;
    this.claudeUnauthorizedToken = null;
    this.claudeLastGood = null;
    this.codexUnauthorizedToken = null;
    if (next) {
      this.pollAllGuarded();
      this.timer = setInterval(() => this.pollAllGuarded(), POLL_MS_BACKGROUND);
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.snapshot = { enabled: false, providers: [], updatedAt: 0 };
      this.emit();
    }
  }

  /** Per-provider mirror of `setEnabled` above — called from main/index.ts on
   *  boot and every settings save with `AppSettings.usageExcludedProviders`.
   *  A newly-excluded provider is never polled again (see `pollAll`'s own
   *  filter) and has its own gate/lock/cache state cleared immediately, same
   *  hygiene `setEnabled(false)` applies to everything: a later re-include
   *  starts clean rather than reusing stale state from before it was
   *  excluded. If a poll already produced a snapshot containing the newly-
   *  excluded provider, strip it and re-emit right away rather than waiting
   *  for the next poll to quietly drop it. Symmetrically, a provider going
   *  the OTHER way (re-included) triggers an immediate poll rather than
   *  waiting up to `POLL_MS_BACKGROUND` for the next background tick — a
   *  user who just ticked the checkbox back on should see that provider's
   *  row appear right away, not up to 5 minutes later. */
  setExcludedProviders(excluded: UsageProviderId[]): void {
    const next = new Set<UsageProviderId>(ALL_USAGE_PROVIDERS.filter((p) => !excluded.includes(p)));
    const newlyExcluded = ALL_USAGE_PROVIDERS.filter((p) => this.includedProviders.has(p) && !next.has(p));
    const newlyIncluded = ALL_USAGE_PROVIDERS.filter((p) => !this.includedProviders.has(p) && next.has(p));
    this.includedProviders = next;
    if (newlyExcluded.includes('claude')) {
      this.claudeGatedUntil = 0;
      this.claudeUnauthorizedToken = null;
      this.claudeLastGood = null;
    }
    if (newlyExcluded.includes('codex')) {
      this.codexUnauthorizedToken = null;
    }
    if (!this.enabled) return;
    if (newlyExcluded.length > 0) {
      this.snapshot = { ...this.snapshot, providers: this.snapshot.providers.filter((p) => next.has(p.provider)) };
      this.emit();
    }
    // Guarded by `this.enabled` above: at boot, setExcludedProviders runs
    // BEFORE setEnabled (see main/index.ts) while `this.enabled` is still
    // false, so this never double-polls alongside setEnabled(true)'s own
    // initial pollAllGuarded() call.
    if (newlyIncluded.length > 0) this.pollAllGuarded();
  }

  getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  /** Popover-open trigger — throttled to once/min (task spec); returns the
   *  (possibly not-actually-refreshed-this-call) current snapshot either
   *  way, so the renderer never has to special-case "throttled". */
  async refreshNow(): Promise<UsageSnapshot> {
    if (!this.enabled) return this.snapshot;
    const now = Date.now();
    if (now - this.lastManualRefresh < MANUAL_REFRESH_MIN_INTERVAL_MS) return this.snapshot;
    this.lastManualRefresh = now;
    await this.pollAllGuarded();
    return this.snapshot;
  }

  private pollAllGuarded(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollAll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollAll(): Promise<void> {
    // Hard guarantee: zero credential access while off. Every other method
    // in this class only ever reaches a credential read through this
    // function (directly, or via pollAllGuarded/refreshNow above), so this
    // one check is the single enforcement point.
    if (!this.enabled) return;
    const [claude, codex] = await Promise.all([
      this.includedProviders.has('claude') ? this.fetchClaude() : Promise.resolve(null),
      this.includedProviders.has('codex') ? this.fetchCodex() : Promise.resolve(null)
    ]);
    // The toggle can flip off WHILE the two fetches above were in flight —
    // `setEnabled(false)` already cleared and emitted an empty snapshot in
    // that case, so this result is stale by the time it lands. Discard it
    // rather than caching/emitting it: without this check, `getSnapshot()`
    // (and a late `usage:snapshot` push) would hand back real usage data
    // after the toggle was switched off, which is exactly what "toggle off
    // = zero credential access" promises never happens.
    if (!this.enabled) return;
    const providers: UsageProviderSnapshot[] = [];
    // Same race, scoped to one provider: `setExcludedProviders` can exclude
    // a provider WHILE its fetch above was already in flight — it already
    // cleared that provider's state and stripped/re-emitted the snapshot at
    // the time it ran, but this poll's OWN result lands after, and without
    // this re-check would rebuild a snapshot that puts the excluded provider
    // right back in (`includedProviders` is re-read here, after the await,
    // not captured before it).
    if (claude && this.includedProviders.has('claude')) providers.push(claude);
    if (codex && this.includedProviders.has('codex')) providers.push(codex);
    this.snapshot = { enabled: true, providers, updatedAt: Date.now() };
    this.emit();
  }

  private emit(): void {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send('usage:snapshot', this.snapshot);
    } catch {
      /* window tore down mid-send */
    }
  }

  private errorSnapshot(provider: UsageProviderId, state: UsageProviderState, message: string): UsageProviderSnapshot {
    return { provider, state, windows: [], message };
  }

  private async fetchClaude(): Promise<UsageProviderSnapshot> {
    const cred = await readClaudeCredential();
    if (!cred?.accessToken) {
      return this.errorSnapshot('claude', 'error', 'usage unavailable');
    }
    if (typeof cred.expiresAt === 'number' && cred.expiresAt <= Date.now()) {
      // Never refresh (research doc §1 "Expiry / refresh") — just report it.
      // A fresh login invalidates this expiry, so also drop any stale
      // unauthorized-token lock from a PREVIOUS credential.
      this.claudeUnauthorizedToken = null;
      return this.errorSnapshot('claude', 'expired', 'expired — open a claude session to refresh');
    }
    if (cred.accessToken === this.claudeUnauthorizedToken) {
      // Same token that already got a 401 from the endpoint itself — don't
      // hammer a dead token every poll; wait for the CLI to rotate it.
      return this.errorSnapshot('claude', 'unauthorized', 'unauthorized — open a claude session to re-authenticate');
    }
    if (Date.now() < this.claudeGatedUntil) {
      return this.claudeStaleOrError();
    }
    try {
      const res = await fetch(CLAUDE_USAGE_URL, { headers: claudeHeaders(cred.accessToken) });
      if (res.status === 429) {
        this.claudeGatedUntil = Date.now() + parseRetryAfterMs(res.headers.get('retry-after'));
        return this.claudeStaleOrError();
      }
      if (res.status === 401) {
        this.claudeUnauthorizedToken = cred.accessToken;
        return this.errorSnapshot('claude', 'unauthorized', 'unauthorized — open a claude session to re-authenticate');
      }
      if (!res.ok) throw new HttpStatusError(res.status, `claude usage endpoint: http ${res.status}`);
      const data = (await res.json()) as ClaudeUsageResponse;
      const windows = mapClaudeUsage(data);
      this.claudeUnauthorizedToken = null;
      this.claudeLastGood = { windows, updatedAt: Date.now() };
      return { provider: 'claude', state: 'ok', windows, updatedAt: this.claudeLastGood.updatedAt };
    } catch (e) {
      log('usage', 'warn', 'claude usage fetch failed', {
        message: e instanceof Error ? e.message : String(e)
      });
      return this.errorSnapshot('claude', 'error', 'usage unavailable');
    }
  }

  /** Under an active 429 gate: show last-known-good data with its own
   *  timestamp rather than an error row, if we have any (feedback:
   *  "show last-known data with a stale timestamp rather than an error"). */
  private claudeStaleOrError(): UsageProviderSnapshot {
    if (this.claudeLastGood) {
      return {
        provider: 'claude',
        state: 'stale',
        windows: this.claudeLastGood.windows,
        updatedAt: this.claudeLastGood.updatedAt,
        message: 'rate limited — showing last known usage'
      };
    }
    return this.errorSnapshot('claude', 'error', 'usage unavailable');
  }

  private async fetchCodex(): Promise<UsageProviderSnapshot | null> {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    if (!existsSync(codexHome)) return null; // no row at all — research doc

    try {
      const fromLogs = await tryCodexRolloutLogs(codexHome);
      if (fromLogs && fromLogs.length > 0) {
        this.codexUnauthorizedToken = null;
        return { provider: 'codex', state: 'ok', windows: fromLogs, updatedAt: Date.now() };
      }
    } catch (e) {
      log('usage', 'warn', 'codex rollout log scan failed', {
        message: e instanceof Error ? e.message : String(e)
      });
      // Fall through to the network fallback below.
    }

    const auth = await readCodexAuth(codexHome);
    const accessToken = auth?.tokens?.access_token;
    if (!accessToken) {
      return this.errorSnapshot('codex', 'error', 'usage unavailable');
    }
    if (accessToken === this.codexUnauthorizedToken) {
      return this.errorSnapshot('codex', 'unauthorized', 'unauthorized — open a codex session to re-authenticate');
    }
    try {
      const data = await fetchCodexNetworkUsage(auth!);
      const windows = mapCodexNetworkUsage(data);
      if (windows.length === 0) return this.errorSnapshot('codex', 'error', 'usage unavailable');
      this.codexUnauthorizedToken = null;
      return { provider: 'codex', state: 'ok', windows, updatedAt: Date.now() };
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 401) {
        this.codexUnauthorizedToken = accessToken;
        return this.errorSnapshot('codex', 'unauthorized', 'unauthorized — open a codex session to re-authenticate');
      }
      log('usage', 'warn', 'codex usage fetch failed', {
        message: e instanceof Error ? e.message : String(e)
      });
      return this.errorSnapshot('codex', 'error', 'usage unavailable');
    }
  }
}
