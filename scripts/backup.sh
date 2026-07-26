#!/bin/sh
# Lemniscate backup: Postgres dump + MinIO object mirror + env-file tarball.
#
# POSIX sh, no host dependencies beyond docker — the same script runs on the
# VPS (manually or from host cron) and inside the opt-in `backup` compose
# profile (docker:cli sidecar with the docker socket mounted).
#
# Usage:
#   scripts/backup.sh [run]     take a backup now (default)
#   scripts/backup.sh prune     only apply the retention policy
#   scripts/backup.sh list      list existing backups
#
# Configuration (env, see docs/backups.md):
#   BACKUP_DIR         target dir          (default: ./backups)
#   RETENTION_DAILY    days to keep all    (default: 14)
#   RETENTION_WEEKLY   extra weekly to keep(default: 4)
#   MINIO_EXCLUDE      mc --exclude pattern, e.g. "device-artifacts*"
#   COMPOSE_PROJECT_NAME  which stack to back up (default: this checkout's)
set -eu
# Backups contain ciphertext secrets and OAuth tokens — never world-readable.
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/lib/backup-common.sh
. "$SCRIPT_DIR/lib/backup-common.sh"

PREFIX=lemniscate

timestamp_now() { date -u +%Y%m%d-%H%M%S; }

# --- Postgres ---------------------------------------------------------------
# Plain dump piped through nothing: pg_dump's exit code is checked before
# gzip runs, so a failed dump can never masquerade as a valid archive.
backup_postgres() {
  _pg=$(require_container postgres)
  _tmp="$BACKUP_DIR/.$PREFIX-pg-$TS.sql"
  log "postgres: dumping $POSTGRES_DB from container ${_pg}"
  docker exec -i "$_pg" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
    > "$_tmp"
  [ -s "$_tmp" ] || die "pg_dump produced an empty file"
  gzip "$_tmp"
  mv "$_tmp.gz" "$BACKUP_DIR/$PREFIX-pg-$TS.sql.gz"
  log "postgres: wrote $PREFIX-pg-$TS.sql.gz ($(du -h "$BACKUP_DIR/$PREFIX-pg-$TS.sql.gz" | cut -f1))"
}

# --- MinIO ------------------------------------------------------------------
# Mirrors every bucket with a throwaway mc container attached to the compose
# network (where the 'minio' service name resolves). The mc image has no tar,
# so the mirror tree leaves the container as a `docker cp` tar stream, gzipped
# on the host — no bind mounts, no tar inside the container, works with
# local, remote and rootless daemons alike.
backup_minio() {
  _minio=$(require_container minio)
  _net=$(container_network "$_minio")
  [ -n "$_net" ] || die "could not determine the compose network of the minio container"
  log "minio: mirroring all buckets via $MC_IMAGE on network $_net"
  _cid=$(docker create --network "$_net" --entrypoint sh \
    -e "MC_USER=$MINIO_ROOT_USER" -e "MC_PASS=$MINIO_ROOT_PASSWORD" \
    -e "MC_EXCLUDE=$MINIO_EXCLUDE" \
    "$MC_IMAGE" -c '
      set -e
      mc alias set local http://minio:9000 "$MC_USER" "$MC_PASS" >/dev/null
      mkdir -p /tmp/mirror
      if [ -n "$MC_EXCLUDE" ]; then
        mc mirror --exclude "$MC_EXCLUDE" local /tmp/mirror
      else
        mc mirror local /tmp/mirror
      fi')
  docker start -a "$_cid"
  _rc=$(docker inspect "$_cid" --format '{{.State.ExitCode}}')
  if [ "$_rc" != 0 ]; then
    docker rm "$_cid" >/dev/null
    die "mc mirror failed (exit $_rc)"
  fi
  _tar="$BACKUP_DIR/.$PREFIX-minio-$TS.tar"
  docker cp "$_cid:/tmp/mirror" - > "$_tar"
  docker rm "$_cid" >/dev/null
  gzip "$_tar"
  mv "$_tar.gz" "$BACKUP_DIR/$PREFIX-minio-$TS.tar.gz"
  log "minio: wrote $PREFIX-minio-$TS.tar.gz ($(du -h "$BACKUP_DIR/$PREFIX-minio-$TS.tar.gz" | cut -f1))"
}

# --- Env files ---------------------------------------------------------------
# Losing backend/.env means losing ENCRYPTION_KEY, which makes every stored
# LLM key / OAuth token in the DB dump unreadable. Host runs only: the
# compose sidecar has no access to the checkout's env files (by design).
backup_env_files() {
  _stage="$BACKUP_DIR/.env-$TS"
  mkdir -p "$_stage/backend" "$_stage/frontend"
  _found=
  for _f in .env backend/.env frontend/.env; do
    if [ -f "$REPO_ROOT/$_f" ]; then
      cp "$REPO_ROOT/$_f" "$_stage/$_f"
      _found=yes
    fi
  done
  if [ -z "$_found" ]; then
    rm -rf "$_stage"
    note "no env files found at $REPO_ROOT — skipping env backup"
    note "(expected inside the compose backup sidecar; run this script on the host to capture .env)"
    return 0
  fi
  tar -czf "$BACKUP_DIR/$PREFIX-env-$TS.tar.gz" -C "$_stage" .
  rm -rf "$_stage"
  log "env: wrote $PREFIX-env-$TS.tar.gz (.env, backend/.env, frontend/.env)"
}

# --- Commands ---------------------------------------------------------------
cmd_run() {
  command -v docker >/dev/null 2>&1 || die "docker CLI not found"
  load_credentials
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  TS=$(timestamp_now)
  backup_postgres
  backup_minio
  backup_env_files
  cmd_prune
  log "backup $TS complete -> $BACKUP_DIR"
}

cmd_prune() {
  mkdir -p "$BACKUP_DIR"
  apply_retention "$PREFIX-pg" "sql.gz"
  apply_retention "$PREFIX-minio" "tar.gz"
  apply_retention "$PREFIX-env" "tar.gz"
}

cmd_list() {
  ls -lh "$BACKUP_DIR/$PREFIX"-* 2>/dev/null || note "no backups in $BACKUP_DIR yet"
}

case ${1:-run} in
  run)   cmd_run ;;
  prune) cmd_prune ;;
  list)  cmd_list ;;
  -h|--help|help)
    sed -n '2,20p' "$0" ;;
  *)
    die "unknown command '$1' (run|prune|list)" ;;
esac
