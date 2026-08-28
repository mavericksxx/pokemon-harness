# usage-limits panel — endpoint & credential research (2026-08-29)

Build spec for BACKLOG item 1 (in-app provider usage limits). Researched read-only from public source: `steipete/CodexBar` (Swift, MIT), `ryoppippi/ccusage`, `openai/codex`, plus GitHub issues and official docs. No local credential files, keychain items, or transcripts were read during research; no authenticated request was made; no CLI was spawned.

Standing constraint this feature operates under (BACKLOG item 1, DECIDED): opt-in toggle, off by default; while on, read the CLI's existing credential + call the usage endpoint + display, and nothing else — never store, proxy, refresh, or implement any sign-in. Toggle off = zero credential access.

---

## 1. Claude Code (Anthropic subscription plans)

### Credential source

**macOS primary storage: Keychain**, not a file.
- Service name: `"Claude Code-credentials"` (constant `ClaudeOAuthCredentialsStore.claudeKeychainService`).
  Source: `CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentials.swift:15`
- CodexBar's Keychain query sets only `kSecAttrService`, **not `kSecAttrAccount`** (`kSecClassGenericPassword`, `kSecAttrService`, `kSecMatchLimitOne`, `kSecReturnAttributes`) — same file, lines 976–992. It does not pin an account name. The account field is **unconfirmed from primary source** — third-party blog posts claim `$USER`; treat as unverified, query by service only.
- Item payload is a JSON blob keyed `claudeAiOauth`:
  ```json
  { "claudeAiOauth": {
      "accessToken": "...", "refreshToken": "...",
      "expiresAt": 1234567890123,
      "scopes": ["..."],
      "rateLimitTier": "...", "subscriptionType": "..."
  }}
  ```
  `expiresAt` is **ms since epoch**. Source: `ClaudeOAuthCredentialModels.swift:97-146`; expiry check `Date() >= expiresAt` at lines 37-40.
- **File fallback** `.credentials.json`: `{configRoot}/.credentials.json` where configRoot = `$CLAUDE_CONFIG_DIR` (else `~/.claude`), overridable by `$CLAUDE_SECURESTORAGE_CONFIG_DIR`. Source: `ClaudeConfigPaths.swift:36-50`. Real storage on Linux/WSL/headless; usually absent on macOS desktops.

### Usage endpoint

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
Accept: application/json
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/<version>        # real CLI's UA; fallback "2.1.0"
```
No `anthropic-version` header. Source: `ClaudeOAuth/ClaudeOAuthUsageFetcher.swift:60-93`.

Companion identity endpoint: `GET https://api.anthropic.com/api/oauth/profile` (same auth, no beta header) → `{account:{email_address}, organization:{uuid}}`.

**Response shape** (decode leniently — every field optional):
```json
{
  "five_hour": { "utilization": 23.5, "resets_at": "2026-08-29T18:00:00Z" },
  "seven_day": { "utilization": 41.2, "resets_at": "2026-09-03T00:00:00Z" },
  "seven_day_oauth_apps": { },
  "seven_day_opus": { },
  "seven_day_sonnet": { },
  "extra_usage": {
    "is_enabled": true, "monthly_limit": 2000, "used_credits": 450,
    "utilization": 22.5, "currency": "USD"
  },
  "limits": [
    { "kind": "weekly_scoped", "group": "weekly", "percent": 12.0,
      "resets_at": "2026-09-03T00:00:00Z",
      "scope": { "model": { "id": "...", "display_name": "Fable" } },
      "is_active": false }
  ]
}
```
- `utilization` / `percent` are already **0–100** (no scaling — confirmed `ClaudeUsageFetcher.swift:1023`, `:1179`).
- `resets_at` is an **ISO-8601 string** here (Codex uses epoch seconds — do not conflate).
- Gauge mapping (from CodexBar `mapOAuthUsage`, `ClaudeUsageFetcher.swift:1003-1090`):
  - 5h session = `five_hour` (fallback chain `seven_day → seven_day_oauth_apps → seven_day_sonnet → seven_day_opus` only if absent)
  - weekly = `seven_day`
  - model-specific card = `seven_day_sonnet ?? seven_day_opus` (flat fields)
  - `limits[]` is **additive only** — extra named rows for scoped/promotional windows (e.g. a "Fable" window via `scope.model.display_name`). Do NOT filter on `is_active` (enforceable scoped limits have been observed reporting `false` — `ClaudeUsageFetcher.swift:1184`).
  - all flat windows absent + `extra_usage.is_enabled` → synthesize a spend-limit gauge; `extra_usage` amounts are in **cents**.
- **429 handling is mandatory**: honor `Retry-After` (seconds or HTTP-date) and hard-block further calls until then (CodexBar gates via `ClaudeOAuthUsageRateLimitGate`, `ClaudeOAuthUsageFetcher.swift:73-119`). Never hammer this endpoint.
- Observed key `iguana_necktie` of unknown purpose — ignore, never render.

### Expiry / refresh

Never refresh. Claude Code rotates refresh tokens; refreshing from outside the CLI can invalidate the CLI's own login (CodexBar itself refuses to self-refresh CLI-owned credentials and instead delegates to the real CLI — `ClaudeOAuthDelegatedRefreshCoordinator.swift`; rationale comment at `ClaudeOAuthCredentials.swift:742`). We also never spawn `claude`. On expired token (`expiresAt` past) or 401: show "open a claude session to refresh" and stop polling until the stored credential changes. The CLI refreshes its own keychain entry during normal use.

### Local-log alternative — confirmed NOT present

Claude transcripts carry only tokens/cost, never quota % (ccusage's full transcript schema: `ccusage rust/crates/ccusage-core/src/types.rs:9-26`). The statusline JSON's `rate_limits` object existed briefly (v2.1.80 changelog) but regressed server-side ~March 2026; tracking issues anthropics/claude-code#40094 / #45133 closed "not planned". **Network path is the only source of quota %.**

---

## 2. OpenAI Codex CLI (ChatGPT-plan auth)

### Credential source

`~/.codex/auth.json` (or `$CODEX_HOME/auth.json`; legacy `~/.config/codex/auth.json`). Source: `CodexOAuthCredentials.swift:98-113, 383-396`. Shapes:
```json
{ "OPENAI_API_KEY": "sk-..." }
```
or
```json
{ "tokens": { "access_token": "...", "refresh_token": "...", "id_token": "...", "account_id": "..." },
  "last_refresh": "2026-08-29T10:00:00Z" }
```
Missing `account_id` is recoverable from the `chatgpt_account_id` claim in the JWT `id_token`/`access_token` (lines 488-521). JWT `exp` is a scheduling hint only, not authoritative (lines 523-536).

### Preferred source: local rollout logs (no network, no credential)

**Codex CLI writes rate-limit snapshots to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` in interactive sessions** (not `codex exec`). Confirmed from current `openai/codex` HEAD:
- Envelope (`codex-rs/history/src/rollout_payload.rs:20-56`): `{"type":"event_msg","payload":{...}}`
- Usage event (`codex-rs/protocol/src/protocol.rs:1332-1400`):
  ```json
  {"type":"token_count","info":{...},"rate_limits":{
    "primary":   { "used_percent": 23.0, "window_minutes": 300,   "resets_at": 1756500000 },
    "secondary": { "used_percent": 6.0,  "window_minutes": 10080, "resets_at": 1757000000 }
  }}
  ```
- `used_percent` f64 0–100; `resets_at` **absolute Unix seconds** (`protocol.rs:2282-2331`). Older wire versions used relative `resets_in_seconds` — schema has changed at least once; verify against the user's installed codex version.
- **Reliability caveat**: openai/codex#14880 / #14728 report `rate_limits` sometimes null even interactively. Strategy: parse the most recent `token_count` event with non-null `rate_limits` (lookback up to ~7 days); fall back to the network call when none found.

### Network fallback

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access_token>
Accept: application/json
ChatGPT-Account-Id: <account_id>          # if known
```
Base configurable via `chatgpt_base_url` in `~/.codex/config.toml` (non-chatgpt.com hosts use path `/api/codex/usage`). Source: `CodexOAuthUsageFetcher.swift:391-456, 594-696`. Response:
```json
{
  "account_id": "...", "plan_type": "plus|pro|team|...",
  "rate_limit": {
    "primary_window":   { "used_percent": 23, "reset_at": 1756500000, "limit_window_seconds": 18000 },
    "secondary_window": { "used_percent": 6,  "reset_at": 1757000000, "limit_window_seconds": 604800 }
  },
  "credits": { "has_credits": true, "unlimited": false, "balance": 40.5 },
  "additional_rate_limits": [ { "limit_name": "...", "rate_limit": { } } ],
  "spend_control": { "individual_limit": { } }
}
```
`used_percent` 0–100 int; `reset_at` epoch **seconds**; `limit_window_seconds`/60 = window minutes (5h=18000s, weekly=604800s). Mapping source: `UsageFetcher.swift:1274-1288`.

### Expiry / refresh

Refresh endpoint is `https://auth.openai.com/oauth/token` (`codex-rs/login/src/auth/manager.rs:197`) and the CLI refreshes + persists `auth.json` itself. Same rule as Claude: **never call it**; on 401 show "open a codex session to refresh".

---

## 3. Cursor CLI — NOT VIABLE v1

No individual usage API exists. Official APIs (Admin/Analytics/Organization, cursor.com/docs) all require an admin-scoped team key. CodexBar's Cursor support works only by importing **browser session cookies** (`WorkosCursorSessionToken` etc.) and calling undocumented cookie-authed endpoints (`cursor.com/api/usage-summary`, `/api/auth/me`, …) — `CursorProviderImplementation.swift:16-227, 1459-1569`. Cookie scraping is outside our constraints. Omit Cursor from v1; show "no public usage api" in its row or hide it. Re-check cursor.com/docs/api occasionally.

---

## 4. Cost/token estimates from local logs (ccusage lessons)

Our transcript gauges should adopt these or knowingly diverge:
- **Dedup key is compound**: `(message.id, requestId)` — not `message.id` alone (`ccusage/rust/adapters/claude/src/lib.rs:147-199`). Secondary `message_id`-only lookup handles sidechain/subagent replays under a new `request_id` (test: `daily.rs:552-598`). Empty-string ids are excluded from dedup matching, not collided on `""` (`lib.rs:430-440`).
- **`message.usage.iterations[]` trap**: advisor/sub-model calls nest an iterations array; ccusage explodes each into a synthetic entry (`"{message_id}:advisor:{index}"`, `lib.rs:304-341`). Reading only top-level `message.usage` under-counts whenever advisor calls occurred.
- **Cost precedence** (`cost.rs:9-42`): Display = transcript's `costUSD` verbatim; Auto = `costUSD` else compute; Calculate = always compute.
- **Pricing source**: LiteLLM's `model_prices_and_context_window.json` (embedded snapshot + live refresh; models.dev fallback) — prefer that over hand-maintained constants (`pricing.rs:14-53, 214-215, 449-458`; upstream prices are per-million tokens).
- Codex local cost: the `token_count` rollout events carry cumulative per-session totals — natural source, ccusage codex-adapter parity unverified.

---

## Risks / unknowns

1. Claude keychain **account** attribute unconfirmed — query by service only.
2. Codex rollout `rate_limits` unreliable/nullable + schema drift → always keep the network fallback.
3. Claude statusline `rate_limits` is dead — do not build on it.
4. All endpoints are reverse-engineered, undocumented, and can change — degrade gracefully (hide the row, never crash) on unexpected schema; every response field optional.
5. Plan types (Pro/Max/Team; Plus/Pro/Team) change which fields populate — mirror CodexBar's all-optional models.
6. Keychain read will trigger a one-time macOS permission prompt for our app the first time — expected; surface a friendly explanation in the settings row before the user flips the toggle.

## Primary source files (all public, read 2026-08-29)

CodexBar: `Providers/Claude/ClaudeOAuth/{ClaudeOAuthCredentials,ClaudeOAuthCredentialModels,ClaudeOAuthUsageFetcher}.swift`, `Providers/Claude/{ClaudeUsageFetcher,ClaudeConfigPaths,ClaudeStatusProbe}.swift`, `ClaudeOAuthDelegatedRefreshCoordinator.swift`, `Providers/Codex/CodexOAuth/{CodexOAuthCredentials,CodexOAuthUsageFetcher}.swift`, `CodexBarCore/UsageFetcher.swift`, `Providers/Cursor/CursorProviderImplementation.swift`
openai/codex: `codex-rs/protocol/src/protocol.rs`, `codex-rs/history/src/rollout_payload.rs`, `codex-rs/login/src/auth/manager.rs`
ccusage: `rust/crates/ccusage-core/src/{types,cost,pricing}.rs`, `rust/adapters/claude/src/{lib,daily}.rs`
Issues: openai/codex#14880 #14728; anthropics/claude-code#45133 #40094. Cursor docs: cursor.com/docs/api (+teams admin/analytics, org admin).
