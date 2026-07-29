# LLM configuration — design spec (implemented)

Users manage one or more LLM configurations in the web UI. Configurations are
stored in Postgres per user; each project (repo) references one config, so a
cheap model can serve small repos and a strong one large repos. A config may be
marked `isDefault` for projects that don't pick one explicitly.

Implemented in `backend/src/routes/llm-configs.ts` (CRUD + test endpoints,
mounted at `/api/llm-configs`) and `backend/src/lib/llm-client.ts`
(OpenAI-compatible client). The agent loop (`backend/src/lib/agent-loop.ts`)
enforces the rate limit and token budget.

All endpoints must expose an OpenAI-compatible `/v1/chat/completions` API
(OpenAI, Azure, vLLM, Ollama, LM Studio, gateways).

## Fields

### Connection
| Field | Notes |
|---|---|
| `name` | Human label, e.g. "My Hermes 70B" |
| `baseUrl` | e.g. `https://api.openai.com/v1` |
| `apiKey` | Encrypted at rest, AES-256-GCM (key from `ENCRYPTION_KEY` env) |
| `model` | Model name passed to the API |

### Generation behavior
| Field | Notes |
|---|---|
| `thinkingLevel` | off / low / medium / high → `reasoning_effort` where supported; on HTTP 400 the client transparently retries without it (prompt injection is not implemented) |
| `temperature` | Default 0.2 (code generation) |
| `maxTokens` | Response cap per request |
| `contextWindow` | Declared model context size; loop uses it to budget repo context in prompts |
| `systemPromptExtra` | Optional user instructions appended to the agent system prompt |

### Reliability / cost control
| Field | Notes |
|---|---|
| `timeoutSeconds` | Default 120 |
| `maxRetries` | Default 3, with backoff |
| `requestsPerMinute` | Rate-limit guard; enforced as a throttle in the agent loop |
| `maxTokensPerRun` | Hard token budget per run; the loop aborts with `TokenBudgetExceededError` when exceeded |
| `inputPricePerMillion` / `outputPricePerMillion` | Optional user-entered USD prices per million tokens. Both must be set for the API to return `estimatedCostUsd` (task DTOs and `GET /api/usage`); with either unset the cost field is omitted rather than guessed. Prices can go stale — the UI labels figures "estimated". |
| `maxCostPerRunUsd` | **Not implemented (future)** — costs are *observed* via the price fields above; use `maxTokensPerRun` as the budget cap |
| `customHeaders` | JSON key/value for gateways needing extra auth/routing headers |

## Usage & cost visibility (implemented)

`chatCompletions()` parses the per-call usage; the runtime accumulates a
cumulative total **and** a prompt/completion split per task
(`Task.llmTokensUsed`, `Task.llmPromptTokens`, `Task.llmCompletionTokens`,
written by `persistTokenUsage`). Rows created before the split columns keep a
NULL split — they contribute token totals but no cost estimate (no fabricated
backfill).

- Task list/detail responses include `llmTokensUsed`, the split, the
  effective `maxTokensPerRun` (task config → repo config → user default), and
  `estimatedCostUsd` when the effective config has both prices.
- `GET /api/usage?period=7d|30d` aggregates per repository and per UTC day.
  Attribution semantics: `llmTokensUsed` is cumulative per task, so a task's
  whole total is attributed to the day it was *created* — an approximation,
  not per-event deltas.

### Housekeeping
| Field | Notes |
|---|---|
| `isDefault` | Fallback config for projects without an explicit one |
| `enabled` | Disable without deleting |

## Failover between configs (implemented)

When the active config's endpoint fails mid-run — unreachable, quota or token
limit exhausted (HTTP 4xx/429/5xx after the client's own retries), timeouts,
or malformed replies — the run does not abort. `llmCall`
(`backend/src/lib/agent-runtime.ts`) routes every call through the failover
chain in `backend/src/lib/llm-failover.ts`:

- The failed config is marked for the rest of the run and the next **enabled**
  config of the same user takes over (default config first, matching the
  primary-resolution precedence), then the call is retried against it.
- Each failed config is tried at most once per run; when no candidate
  remains, the original error propagates and the run fails as before.
- A rotated-in config gets the same baseUrl SSRF gate as the primary one;
  its decrypted key is registered on the run's secret scrub list, and the
  switch is logged to the task console
  (`⚠ LLM failover: <model> failed (…) — switching to <model> [name]`).
- Token usage accumulates across configs, so `maxTokensPerRun` of the
  currently active config still applies — the per-run budget itself is a
  deliberate cap and never triggers failover.

### Cross-run exhaustion ("limit reached → switch default")

In-run failover alone would let the NEXT run resolve the same exhausted
default again and burn its configured retries against the still-limited
endpoint before failing over. When the failure is a rate-limit/quota signal
— HTTP 429, `insufficient_quota`, `RESOURCE_EXHAUSTED`, "usage limit reached"
and friends (the single classifier in `backend/src/lib/llm-rate-limit.ts`) —
the failed config is additionally **parked** cross-run
(`backend/src/lib/llm-exhaustion.ts`):

- A Redis record `llm-exhausted:<configId> = {until, reason}` is written with
  a PX TTL equal to the cooldown. The cooldown honors the provider's own
  reset time when the error message states one (clamped to [10min, 6h]);
  otherwise it falls back to `LLM_EXHAUSTION_COOLDOWN_MS` (default 1h).
- While parked, the config is skipped both by primary resolution
  (`findLlmConfig` in `llm-config-resolution.ts` → the promoted config
  effectively becomes the default for new runs) and by the failover
  candidate list.
- **Automatic recovery:** TTL expiry is the recovery mechanism — once the
  provider's limit window resets, the record disappears and the previous
  default is preferred again. No probe job, no manual switching.
- Only quota signals park a config: a persistent failure caused by a
  malformed request (or an endpoint simply being down) fails over within the
  run but is NOT remembered cross-run, so failover never masks real bugs.
- Degradation: when every enabled config is parked, or Redis is down, the
  system falls back to the stored config order — i.e. exactly the pre-
  existing in-run failover behavior.

Every switch is observable: counted as `lemniscate_llm_failovers_total
{reason="rate_limit"|"other"}` (see `docs/observability.md`) and surfaced to
the user as an `llm_failover` notification (bell + subscribed webhook/email/
browser channels, deduped per task) including the parked-until recovery time.

## Test connection (implemented)

A **"Test connection"** button in the config form sends a trivial
`chat/completions` request through the backend and reports the result before
the user ever runs the loop.

- Backend endpoint: `POST /api/llm-configs/test` (accepts an unsaved config
  payload, so users can test before saving) and `POST /api/llm-configs/:id/test`
  for saved configs.
- The backend — not the browser — calls the LLM, so the API key never leaves
  the server and CORS is not an issue.
- Test request: a fixed trivial prompt (e.g. "Reply with the word 'ok'"), small
  `maxTokens`, short timeout (~30s, capped regardless of config).
- Response to the UI:
  - `ok: boolean`
  - `latencyMs`
  - `modelEcho` — model name reported by the server, so users catch
    "I asked for X but the endpoint serves Y"
  - `reply` — the actual text returned
  - `error` — sanitized message on failure (DNS/auth/timeout/4xx-5xx), never
    leaking the API key

## xAI OAuth (SuperGrok / X Premium+) (implemented)

Settings → LLM configs includes a **Connect with xAI** button that runs the
OAuth 2.0 device-code flow against `auth.x.ai` (same grant Hermes uses). No
`XAI_API_KEY` is required.

1. `POST /api/llm-configs/xai-oauth/start` — returns `sessionId`, `userCode`,
   `verificationUrl`, poll `interval`, and the coding model list (default
   `grok-4.5`).
2. The UI opens the verification URL; `POST …/poll` with `{ sessionId }` until
   `status: "authorized"` (or timeout / denial).
3. `POST …/complete` with `{ sessionId, model, isDefault? }` creates an
   `LlmConfig` with `authType: "oauth"`, access token in `apiKeyEnc`, refresh
   token in `refreshTokenEnc`, and cached `oauthTokenEndpoint`.

Runtime calls resolve the Bearer token through `resolveLlmAccessToken`
(`backend/src/lib/llm-access-token.ts`), which refreshes near JWT expiry and
persists the rotated pair. Re-auth message when the refresh grant dies:
reconnect via Settings → LLM configs.
