# Observability

Lemniscate exposes Prometheus metrics from both processes and supports
opt-in Sentry error reporting. Everything is off by default and safe to
leave unconfigured.

## Endpoints

| Process | Endpoint | Guard |
| --- | --- | --- |
| backend (API) | `GET /metrics` on :3000 | `Authorization: Bearer $METRICS_TOKEN`; **404 when `METRICS_TOKEN` is unset** |
| worker | `GET /metrics` on the worker health port (:3100 in-container, published as `127.0.0.1:3101`) | bound to localhost by compose (`WORKER_HEALTH_BIND`) |

The backend `/metrics` is intentionally unreachable from the public site:
the frontend nginx only proxies `/api/` and `/assets/`, so an unprefixed
`/metrics` never leaves the host even before the token check. The token
guard is the second layer — generate one and keep it in the Prometheus
config only:

```sh
openssl rand -hex 32   # → METRICS_TOKEN in the compose environment
```

Scrape both jobs:

```yaml
scrape_configs:
  - job_name: lemniscate-api
    scrape_interval: 15s
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['127.0.0.1:3000']
  - job_name: lemniscate-worker
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:3101']   # WORKER_HEALTH_BIND host port
```

## Metric families (all prefixed `lemniscate_`)

- `http_requests_total`, `http_request_duration_seconds` — API requests by
  `method`, route **template** (`/tasks/:id`, never raw URLs), `status_code`.
- `queue_jobs{queue,state}` — BullMQ job counts (waiting/active/delayed/
  failed/completed), refreshed every 15s by the worker.
- `job_duration_seconds{job_name}`, `job_failures_total{job_name,error_kind}`
  — every BullMQ job run, wrapped by `metrics.observeJob` in `worker.ts`.
- `llm_requests_total{outcome}`, `llm_request_duration_seconds{outcome}` —
  every chat-completions call; outcome is `success` or the `LlmError` kind
  (`http` / `timeout` / `network` / `protocol`).
- `llm_failovers_total{reason}` — cross-config failovers
  (`lib/llm-failover.ts`); `rate_limit` when the provider's quota/token limit
  triggered the switch (the failed config is then parked cross-run, see
  `docs/llm-config.md`), `other` for any other endpoint failure.

Label cardinality is bounded by construction: route templates, job names
and error constructor names only — never job IDs, task IDs, URLs or model
names.

## Starter alert rules

```yaml
groups:
  - name: lemniscate
    rules:
      # 1. Queue backing up: work waiting >10 minutes.
      - alert: LemniscateQueueBacklog
        expr: lemniscate_queue_jobs{state="waiting"} > 10
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: Agent task queue has {{ $value }} waiting jobs for >10m
      # 2. Job failure spike vs the previous hour.
      - alert: LemniscateJobFailureSpike
        expr: |
          sum(rate(lemniscate_job_failures_total[15m]))
            > 2 * sum(rate(lemniscate_job_failures_total[1h] offset 1h))
          and sum(rate(lemniscate_job_failures_total[15m])) > 0.01
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: Worker job failure rate is spiking
      # 3. Readiness flapping: /health/ready changing state repeatedly.
      - alert: LemniscateReadinessFlapping
        expr: changes(probe_success{job=~"lemniscate-(api|worker)"}[30m]) > 6
        for: 0m
        labels: { severity: warning }
        annotations:
          summary: Readiness probe flapping (dependency instability)
```

(Rule 3 assumes the blackbox exporter or `up`/`probe_success` series for the
health endpoints; substitute `up{job="lemniscate-worker"}` if you rely on
scrape health alone.)

## Sentry (opt-in)

Set `SENTRY_DSN` in the compose environment for the backend and worker.
When unset the SDK is never imported and reporting is a no-op. When set:

- API: 5xx errors from the Fastify error handler are captured.
- Worker: every BullMQ `failed` event is captured with job name, job ID and
  task ID as context.

Before any event leaves the process it passes through `scrubEvent`
(`backend/src/lib/sentry.ts`), which redacts every occurrence of
`MONITORED_SECRETS` (`JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`) in all nested strings. Per-user LLM API keys are already
scrubbed at the source: `llm-client.ts` never includes the key in thrown
errors.

## Verifying by hand

```sh
docker compose up --build -d
curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics | head
curl http://127.0.0.1:3101/metrics | grep lemniscate_queue_jobs
# Through the public proxy there is no route:
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/metrics   # → 404
```

Enqueue a task that fails (e.g. against an unreachable repo) and within one
scrape interval `lemniscate_job_failures_total{job_name="run-task",...}`
increments on the worker endpoint; with `SENTRY_DSN` set the same failure
appears in Sentry within seconds.
