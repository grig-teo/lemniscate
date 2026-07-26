# E2E smoke suite — core agent loop on the real compose stack

`tests/e2e/` boots the full stack (`docker-compose.yml` +
`tests/e2e/docker-compose.e2e.yml`) against real Postgres/Redis/MinIO and
drives one full task lifecycle through the API, with fakes only at the
network edges:

- **gitstub** (`tests/e2e/gitstub/`): a single container serving a bare git
  repo over HTTPS plus a GitVerse-shaped provider API (the suite connects
  with provider `gitverse` + `baseUrl https://gitstub`, so repo sync and the
  agent's clone/push all hit this container), and a deterministic
  OpenAI-compatible stub LLM whose canned change-set response comes from
  `llm-fixture.json`. No external secrets or network access are needed.
- **seed** (`tests/e2e/seed.mjs`): runs inside the backend container and
  creates one user + git connection through the real compiled Prisma/crypto
  code.
- **smoke tests** (`tests/e2e/smoke.test.mjs`): assert `/health/ready`
  (backend) and worker `:3100/health/ready`, then repo connect, task create,
  status transitions `queued → running → done`, a branch pushed to the
  gitstub remote, and the stub LLM's output in the task console.

The stub LLM's fixture is locked against the agent loop's parsing contract by
`backend/tests/e2e-stub-llm-fixture.test.ts` — when `agent-prompts.ts` or
`llm-json.ts` change, that unit test forces the fixture to move with them.

## Running locally

```sh
./tests/e2e/run.sh
```

The script is idempotent: it always starts from throwaway volumes
(`down -v` before and after) and never touches your normal compose project
(it uses the separate project name `lemniscate-e2e`). Health waits and the
test runner execute inside a throwaway container on the compose network, so
no published host ports are required. If `backend/.env` is missing, a
throwaway one is generated (an existing one is never overwritten).

### Knobs

| Env var | Default | Meaning |
| --- | --- | --- |
| `KEEP_E2E` | unset | `KEEP_E2E=1` leaves the stack running after the run (debugging; tear down with `docker compose -p lemniscate-e2e -f docker-compose.yml -f tests/e2e/docker-compose.e2e.yml down -v`) |
| `E2E_HEALTH_TIMEOUT_SECONDS` | 360 | Per-service health-wait budget |
| `E2E_TASK_TIMEOUT_SECONDS` | 300 | Budget for the task to go `queued → done` |

On failure, logs for every service (backend, worker, gitstub, …) are dumped
to `tests/e2e/artifacts/`.

## CI

The `e2e` job in `.github/workflows/ci.yml` is path-filtered (`backend/**`,
`frontend/**`, `docker-compose.yml`, `tests/e2e/**`, the workflow itself),
runs `./tests/e2e/run.sh` with a 15-minute timeout, and uploads
`tests/e2e/artifacts/` (service logs) as a build artifact on failure. It is
intended to be a required merge check: a skipped run (paths not matched)
counts as success, so it only gates PRs that touch the stack.

## Scope

Deliberately one happy-path loop plus boot checks. New behavioral cases
belong in unit/integration tests; add e2e cases only for regressions that
cannot be caught below the compose level. Keep total runtime under 10
minutes.
