#!/bin/sh
# Lemniscate restore: rebuild Postgres and MinIO from a backup taken by
# scripts/backup.sh, then restart the stack and verify readiness.
#
# Usage:
#   scripts/restore.sh <TIMESTAMP|latest> [--yes] [--with-env]
#
#   TIMESTAMP      backup id, e.g. 20260726-030000 (see scripts/backup.sh list)
#   --yes          skip the interactive confirmation (for automation)
#   --with-env     also restore .env / backend/.env / frontend/.env from the
#                  env tarball (required when restoring onto a fresh machine —
#                  without ENCRYPTION_KEY all stored secrets stay unreadable)
#
# The script stops backend/worker/frontend/traefik, restores the dump and
# the object mirror, starts the stack again and polls /health/ready.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/lib/backup-common.sh
. "$SCRIPT_DIR/lib/backup-common.sh"

PREFIX=lemniscate
ASSUME_YES=
WITH_ENV=
TS=

while [ $# -gt 0 ]; do
  case $1 in
    --yes|-y)   ASSUME_YES=yes ;;
    --with-env) WITH_ENV=yes ;;
    -h|--help)  sed -n '2,17p' "$0"; exit 0 ;;
    -*)         die "unknown flag '$1'" ;;
    *)          [ -z "$TS" ] || die "unexpected extra argument '$1'"; TS=$1 ;;
  esac
  shift
done

[ -n "$TS" ] || die "usage: scripts/restore.sh <TIMESTAMP|latest> [--yes] [--with-env]"

# --- Locate the backup set --------------------------------------------------
PG_DUMP="$BACKUP_DIR/$PREFIX-pg-$TS.sql.gz"
if [ "$TS" = latest ]; then
  PG_DUMP=$(ls -1 "$BACKUP_DIR/$PREFIX-pg"-*.sql.gz 2>/dev/null | sort | tail -n1)
  [ -n "$PG_DUMP" ] || die "no backups found in $BACKUP_DIR"
  _base=${PG_DUMP##*/}
  TS=${_base#"$PREFIX"-pg-}
  TS=${TS%.sql.gz}
  PG_DUMP="$BACKUP_DIR/$PREFIX-pg-$TS.sql.gz"
fi
MINIO_ARCHIVE="$BACKUP_DIR/$PREFIX-minio-$TS.tar.gz"
ENV_ARCHIVE="$BACKUP_DIR/$PREFIX-env-$TS.tar.gz"

[ -f "$PG_DUMP" ] || die "postgres dump not found: $PG_DUMP"
[ -f "$MINIO_ARCHIVE" ] || note "WARNING: no MinIO archive for $TS — object storage will NOT be restored"
if [ "$WITH_ENV" = yes ] && [ ! -f "$ENV_ARCHIVE" ]; then
  die "--with-env given but no env archive exists for $TS"
fi

# --- Confirmation ------------------------------------------------------------
if [ -z "$ASSUME_YES" ]; then
  [ -t 0 ] || die "refusing to restore without a terminal; pass --yes to confirm non-interactively"
  printf 'This will OVERWRITE the current database and MinIO objects with backup %s.\n' "$TS"
  printf 'Type the timestamp (%s) to confirm: ' "$TS"
  read -r _answer
  [ "$_answer" = "$TS" ] || die "confirmation did not match — aborting, nothing was changed"
fi

load_credentials
STOPPED=

# --- Stop the app tier -------------------------------------------------------
stop_app_services() {
  for _svc in backend worker frontend traefik; do
    _cid=$(find_container "$_svc")
    if [ -n "$_cid" ]; then
      log "stopping $_svc ($_cid)"
      docker stop "$_cid" >/dev/null
      STOPPED="$STOPPED $_cid"
    fi
  done
}

start_app_services() {
  if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && have_compose && [ -f "$REPO_ROOT/docker-compose.yml" ]; then
    log "starting the stack via docker compose up -d"
    (cd "$REPO_ROOT" && docker compose up -d)
  elif [ -n "$STOPPED" ]; then
    log "starting previously stopped containers"
    docker start $STOPPED >/dev/null
  fi
}

# --- Postgres restore ---------------------------------------------------------
restore_postgres() {
  _pg=$(require_container postgres)
  _tmp="$BACKUP_DIR/.restore-$TS.sql"
  log "postgres: decompressing dump"
  gzip -dc "$PG_DUMP" > "$_tmp"
  log "postgres: restoring into $POSTGRES_DB (container $_pg)"
  # ON_ERROR_STOP: any failed statement aborts the restore with non-zero exit.
  docker exec -i "$_pg" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q \
    < "$_tmp"
  rm -f "$_tmp"
  log "postgres: restore finished"
}

# --- MinIO restore ------------------------------------------------------------
# Reverse of backup_minio: push the tar stream into a created mc container
# (`docker cp -`), then start it to recreate each bucket and mirror the
# objects back. No bind mounts, no tar inside the container.
restore_minio() {
  [ -f "$MINIO_ARCHIVE" ] || return 0
  _minio=$(require_container minio)
  _net=$(container_network "$_minio")
  log "minio: restoring buckets via $MC_IMAGE"
  _cid=$(docker create --network "$_net" --entrypoint sh \
    -e "MC_USER=$MINIO_ROOT_USER" -e "MC_PASS=$MINIO_ROOT_PASSWORD" \
    "$MC_IMAGE" -c '
      set -e
      mc alias set local http://minio:9000 "$MC_USER" "$MC_PASS" >/dev/null
      for d in /tmp/mirror/*; do
        [ -d "$d" ] || continue
        b=$(basename "$d")
        echo "restoring bucket: $b"
        mc mb --ignore-existing "local/$b"
        mc mirror --overwrite "$d" "local/$b"
      done')
  _tar="$BACKUP_DIR/.restore-minio-$TS.tar"
  gzip -dc "$MINIO_ARCHIVE" > "$_tar"
  docker cp - "$_cid:/tmp" < "$_tar"
  rm -f "$_tar"
  docker start -a "$_cid"
  _rc=$(docker inspect "$_cid" --format '{{.State.ExitCode}}')
  docker rm "$_cid" >/dev/null
  [ "$_rc" = 0 ] || die "mc restore failed (exit $_rc)"
  log "minio: restore finished"
}

# --- Env files -----------------------------------------------------------------
restore_env_files() {
  [ "$WITH_ENV" = yes ] || return 0
  log "env: restoring .env files into $REPO_ROOT"
  tar -xzf "$ENV_ARCHIVE" -C "$REPO_ROOT"
  chmod 600 "$REPO_ROOT/.env" "$REPO_ROOT/backend/.env" "$REPO_ROOT/frontend/.env" 2>/dev/null || true
}

# --- Verification ---------------------------------------------------------------
verify_stack() {
  _pg=$(find_container postgres)
  if [ -n "$_pg" ]; then
    log "waiting for postgres to accept connections"
    _i=0
    until docker exec "$_pg" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
      _i=$((_i + 1)); [ "$_i" -lt 30 ] || die "postgres did not become ready"
      sleep 1
    done
  fi
  _backend=$(find_container backend)
  if [ -n "$_backend" ] && command -v curl >/dev/null 2>&1; then
    _url=${HEALTH_URL:-http://127.0.0.1:3000/health/ready}
    log "verifying backend readiness at $_url"
    _i=0
    until curl -fsS "$_url" >/dev/null 2>&1; do
      _i=$((_i + 1)); [ "$_i" -lt 60 ] || die "backend did not become ready — check: docker compose logs backend"
      sleep 2
    done
    log "backend reports ready"
  else
    note "no backend container (or no curl) — skipping /health/ready check"
  fi
}

stop_app_services
restore_postgres
restore_minio
restore_env_files
start_app_services
verify_stack
log "restore of backup $TS complete"
