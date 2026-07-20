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
| `maxCostPerRunUsd` | **Not implemented (future)** — no cost tracking yet; use `maxTokensPerRun` as the budget cap |
| `customHeaders` | JSON key/value for gateways needing extra auth/routing headers |

### Housekeeping
| Field | Notes |
|---|---|
| `isDefault` | Fallback config for projects without an explicit one |
| `enabled` | Disable without deleting |

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
