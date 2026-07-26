#!/usr/bin/env bash
# E2E smoke suite: boots the real compose stack (plus the gitstub edge
# fakes), seeds one user, and drives one full task lifecycle through the API.
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
"${COMPOSE[@]}" up -d --build

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
# gitstub serves a self-signed cert by design (-k).
wait_http_ok "gitstub https"         "https://gitstub/e2e-repo.git/info/refs?service=git-upload-pack" -k || fail

log "seeding user + git connection inside the backend container"
# docker cp instead of a bind mount: works even when the daemon cannot see
# the client's filesystem (remote/sandboxed daemons).
BACKEND_CID="$("${COMPOSE[@]}" ps -q backend)"
docker cp tests/e2e/seed.mjs "$BACKEND_CID:/tmp/e2e-seed.mjs" || fail
E2E_SEED="$("${COMPOSE[@]}" exec -T backend node /tmp/e2e-seed.mjs | tail -n 1)" || fail
log "seed: $E2E_SEED"

log "running smoke tests (inside the compose network)"
if ! docker run --rm \
  --network "$NETWORK" \
  -e E2E_BACKEND_URL="http://backend:3000" \
  -e E2E_WORKER_HEALTH_URL="http://worker:3100" \
  -e E2E_FRONTEND_URL="http://frontend:80" \
  -e E2E_GITSTUB_URL="https://gitstub" \
  -e E2E_SEED="$E2E_SEED" \
  -e E2E_TASK_TIMEOUT_SECONDS="${E2E_TASK_TIMEOUT_SECONDS:-300}" \
  "$RUNNER_IMAGE"; then
  FAILED=1
  exit 1
fi

log "SMOKE SUITE PASSED"
