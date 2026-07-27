#!/usr/bin/env bash
# E2E smoke suite: boots the real compose stack plus a throwaway Gitea git
# server and a deterministic mock LLM, seeds one user/connection/repository,
# and drives the product's core value chain through the real API:
#
#   PAT connect (login) -> repository sync -> LLM config -> task run ->
#   branch push -> asserted pull-request creation on Gitea, plus token-usage,
#   notification and metrics assertions, and the human review-feedback loop:
#   a scripted review comment (posted as a second Gitea user) -> poll
#   fallback -> asserted follow-up commit on the PR branch.
#
# Idempotent: always starts from throwaway volumes and always tears them
# down again.
#
# Health waits and the test runner execute inside a throwaway container on
# the compose network, so the suite never depends on published host ports
# (CI runners, dev machines, and sandboxed daemons all behave the same).
#
# Usage:
#   ./tests/e2e/run.sh            # full run, cleanup on exit
#   KEEP_E2E=1 ./tests/e2e/run.sh # keep the stack up afterwards (debugging)
#
# Env knobs:
#   E2E_HEALTH_TIMEOUT_SECONDS  (default 360) per-service health wait budget
#   E2E_TASK_TIMEOUT_SECONDS    (default 300) task queued->done budget
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="lemniscate-e2e"
NETWORK="${PROJECT}_default"
RUNNER_IMAGE="lemniscate-e2e-testrunner"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f tests/e2e/docker-compose.e2e.yml)
ARTIFACTS="tests/e2e/artifacts"
HEALTH_TIMEOUT="${E2E_HEALTH_TIMEOUT_SECONDS:-360}"

# Ephemeral host ports for every published service (base file's *_BIND
# vars). Nothing in the suite uses them — they exist for manual debugging.
export POSTGRES_BIND=127.0.0.1:0 REDIS_BIND=127.0.0.1:0 MINIO_BIND=127.0.0.1:0
export BACKEND_BIND=127.0.0.1:0 WORKER_HEALTH_BIND=127.0.0.1:0
export FRONTEND_BIND=127.0.0.1:0 TRAEFIK_BIND=127.0.0.1:0

log() { printf '[e2e] %s\n' "$*"; }

# The base compose file requires backend/.env (env_file). In a fresh clone it
# does not exist; generate a throwaway one. Never overwrite a developer's.
if [ ! -f backend/.env ]; then
  log "backend/.env missing — generating throwaway e2e values"
  cat > backend/.env <<'EOF'
PORT=3000
WORKER_HEALTH_PORT=3100
FRONTEND_URL=http://localhost:8180
BACKEND_URL=http://localhost:3000
OAUTH_CALLBACK_URL=http://localhost:3000/api/auth
DATABASE_URL=postgresql://lemniscate:lemniscate@postgres:5432/lemniscate
REDIS_URL=redis://redis:6379
JWT_SECRET=e2e-only-jwt-secret-not-for-production-0123456789
ENCRYPTION_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
EOF
fi

FAILED=0

# Any failure path must flip FAILED so cleanup() dumps service logs to
# $ARTIFACTS (CI uploads them) before tearing down — boot/seed failures are
# exactly the regression class this suite exists to catch.
fail() { FAILED=1; exit 1; }

dump_logs() {
  mkdir -p "$ARTIFACTS"
  for svc in backend worker gitstub frontend; do
    "${COMPOSE[@]}" logs --no-color "$svc" > "$ARTIFACTS/$svc.log" 2>&1 || true
  done
  log "service logs written to $ARTIFACTS/"
}

cleanup() {
  if [ "$FAILED" -ne 0 ]; then
    log "FAILURE — dumping service logs"
    dump_logs
  fi
  if [ "${KEEP_E2E:-0}" = "1" ]; then
    log "KEEP_E2E=1 — leaving the stack running (project $PROJECT)"
    return
  fi
  log "tearing down (down -v)"
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Idempotent start: wipe any leftovers from a previous run.
log "cleaning previous e2e state"
"${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true

log "building the test-runner image"
docker build -q -t "$RUNNER_IMAGE" -f tests/e2e/testrunner/Dockerfile tests/e2e > /dev/null

log "building and starting the stack"
"${COMPOSE[@]}" up -d --build || fail

# Run a command inside a throwaway container on the compose network.
in_network() {
  docker run --rm --network "$NETWORK" "$RUNNER_IMAGE" "$@"
}

fail_fast_if_crashed() {
  local crashed
  crashed="$("${COMPOSE[@]}" ps --status exited --status restarting --format '{{.Service}}' 2>/dev/null || true)"
  if [ -n "$crashed" ]; then
    log "container(s) crashed during startup: $crashed"
    return 1
  fi
  return 0
}

wait_http_ok() { # name url curl-extra-args...
  local name="$1" url="$2"
  shift 2
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  log "waiting for $name ($url)"
  until in_network curl -sf --max-time 5 "$@" "$url" > /dev/null 2>&1; do
    if ! fail_fast_if_crashed; then return 1; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "timed out waiting for $name"
      return 1
    fi
    sleep 2
  done
  log "$name is up"
}

wait_http_ok "backend /health/ready" "http://backend:3000/health/ready" || fail
wait_http_ok "worker /health/ready"  "http://worker:3100/health/ready"  || fail
wait_http_ok "frontend /"            "http://frontend:80/"              || fail
# gitstub is the TLS edge in front of Gitea, which serves a self-signed cert
# by design (-k). /api/healthz proves the git vhost proxy; /version (through
# api.gitstub -> /api/v1 rewrite) proves the REST API path the backend's
# GitVerse client will use.
wait_http_ok "gitea via gitstub edge"  "https://gitstub/api/healthz"  -k || fail
wait_http_ok "gitea api via api vhost" "https://api.gitstub/version"  -k || fail

log "seeding Gitea: user + access token + repository"
GITEA_CID="$("${COMPOSE[@]}" ps -q gitea)"
[ -n "$GITEA_CID" ] || fail
docker exec -u git "$GITEA_CID" gitea admin user create \
  --username e2e-user --password 'e2e-password-not-used' \
  --email e2e@example.com --must-change-password=false > /dev/null || fail
E2E_PAT="$(docker exec -u git "$GITEA_CID" gitea admin user generate-access-token \
  --username e2e-user --token-name e2e --scopes all --raw | tail -n 1)" || fail
[ -n "$E2E_PAT" ] || fail

# A second Gitea user plays the human reviewer: the address-review loop
# ignores comments authored by the connection's own account (e2e-user), so
# the scripted review comment must come from someone else.
log "seeding Gitea: reviewer user + access token"
docker exec -u git "$GITEA_CID" gitea admin user create \
  --username e2e-reviewer --password 'e2e-password-not-used' \
  --email reviewer@example.com --must-change-password=false > /dev/null || fail
E2E_REVIEWER_PAT="$(docker exec -u git "$GITEA_CID" gitea admin user generate-access-token \
  --username e2e-reviewer --token-name e2e --scopes all --raw | tail -n 1)" || fail
[ -n "$E2E_REVIEWER_PAT" ] || fail

# Repository + the src/ fixture file, via Gitea's real REST API (reachable
# in-network as plain HTTP; the TLS edge is only for the stack under test).
SRC_FIXTURE_B64="$(printf '%s' 'console.log("hello from the e2e fixture");' | base64 | tr -d '\n')"
in_network sh -c "
  set -e
  curl -sf -X POST -H 'Authorization: Bearer $E2E_PAT' \
    -H 'content-type: application/json' \
    -d '{\"name\":\"e2e-repo\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}' \
    http://gitea:3000/api/v1/user/repos > /dev/null
  curl -sf -X PUT -H 'Authorization: Bearer $E2E_PAT' \
    -H 'content-type: application/json' \
    -d '{\"message\":\"add src fixture\",\"content\":\"$SRC_FIXTURE_B64\",\"branch\":\"main\"}' \
    http://gitea:3000/api/v1/repos/e2e-user/e2e-repo/contents/src/index.js > /dev/null
  curl -sf -X PUT -H 'Authorization: Bearer $E2E_PAT' \
    -H 'content-type: application/json' \
    -d '{\"permission\":\"write\"}' \
    http://gitea:3000/api/v1/repos/e2e-user/e2e-repo/collaborators/e2e-reviewer > /dev/null
" || fail

log "seeding user + git connection inside the backend container"
# docker cp instead of a bind mount: works even when the daemon cannot see
# the client's filesystem (remote/sandboxed daemons). The connection stores
# the REAL Gitea token so PAT connect and every provider call authenticate
# against Gitea exactly as in production.
BACKEND_CID="$("${COMPOSE[@]}" ps -q backend)"
docker cp tests/e2e/seed.mjs "$BACKEND_CID:/tmp/e2e-seed.mjs" || fail
E2E_SEED="$("${COMPOSE[@]}" exec -T -e E2E_SEED_TOKEN="$E2E_PAT" backend node /tmp/e2e-seed.mjs | tail -n 1)" || fail
log "seed: $E2E_SEED"

log "running smoke tests (inside the compose network)"
if ! docker run --rm \
  --network "$NETWORK" \
  -e E2E_BACKEND_URL="http://backend:3000" \
  -e E2E_WORKER_HEALTH_URL="http://worker:3100" \
  -e E2E_FRONTEND_URL="http://frontend:80" \
  -e E2E_GITSTUB_URL="https://gitstub" \
  -e E2E_GITSTUB_API_URL="https://api.gitstub" \
  -e E2E_PAT="$E2E_PAT" \
  -e E2E_REVIEWER_PAT="$E2E_REVIEWER_PAT" \
  -e E2E_METRICS_TOKEN="${E2E_METRICS_TOKEN:-e2e-metrics-token}" \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -e E2E_SEED="$E2E_SEED" \
  -e E2E_TASK_TIMEOUT_SECONDS="${E2E_TASK_TIMEOUT_SECONDS:-300}" \
  "$RUNNER_IMAGE"; then
  FAILED=1
  exit 1
fi

log "SMOKE SUITE PASSED"
