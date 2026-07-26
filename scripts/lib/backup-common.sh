# Shared helpers for scripts/backup.sh and scripts/restore.sh.
# Sourced, not executed. POSIX sh (also runs under busybox ash inside the
# docker:cli backup sidecar — no bashisms allowed here).

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Absolute path of the repository root (parent of scripts/). SCRIPT_DIR must
# be set by the entry script before sourcing this file ($0 inside a sourced
# file still points at the entry script, so it cannot be derived here).
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Directory backups are written to / restored from. Configurable.
BACKUP_DIR=${BACKUP_DIR:-"$REPO_ROOT/backups"}

# Retention policy: keep everything from the last RETENTION_DAILY days, plus
# the newest backup per 7-day bucket for RETENTION_WEEKLY further weeks.
RETENTION_DAILY=${RETENTION_DAILY:-14}
RETENTION_WEEKLY=${RETENTION_WEEKLY:-4}

# Pinned (never :latest), matches the MinIO server pin style in compose.
MC_IMAGE=${MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z}

# Optional mc mirror exclude pattern (e.g. "device-artifacts*" to skip the
# expendable, TTL-managed artifact bucket).
MINIO_EXCLUDE=${MINIO_EXCLUDE:-}

# Read one KEY=value from an env file without sourcing it (no code execution,
# no quote handling surprises). Prints the raw value or nothing. Always
# returns 0: it runs inside command substitutions under `set -e`.
env_file_value() {
  _key=$1 _file=$2
  [ -f "$_file" ] || return 0
  sed -n "s/^${_key}=//p" "$_file" | head -n1
  return 0
}

# Load the credentials backup/restore need, honoring the same sources and
# defaults as docker-compose.yml: process env first, then the root .env that
# the install scripts generate, then the compose defaults.
load_credentials() {
  _root_env="$REPO_ROOT/.env"
  POSTGRES_USER=${POSTGRES_USER:-$(env_file_value POSTGRES_USER "$_root_env")}
  POSTGRES_USER=${POSTGRES_USER:-lemniscate}
  POSTGRES_DB=${POSTGRES_DB:-$(env_file_value POSTGRES_DB "$_root_env")}
  POSTGRES_DB=${POSTGRES_DB:-lemniscate}
  MINIO_ROOT_USER=${MINIO_ROOT_USER:-$(env_file_value MINIO_ROOT_USER "$_root_env")}
  MINIO_ROOT_USER=${MINIO_ROOT_USER:-lemniscate}
  MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-$(env_file_value MINIO_ROOT_PASSWORD "$_root_env")}
  MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-lemniscate-minio}
  export POSTGRES_USER POSTGRES_DB MINIO_ROOT_USER MINIO_ROOT_PASSWORD
}

have_compose() { docker compose version >/dev/null 2>&1; }

# Compose project name. Priority: COMPOSE_PROJECT_NAME env, then (inside the
# backup sidecar, whose hostname is its own container id) our own container
# labels. Empty when undeterminable (host use goes through `compose ps`).
project_name() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s\n' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  docker inspect "$(hostname)" \
    --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null \
    | head -n1
}

# Print the container id of a running compose service, or nothing.
# On the host, `docker compose ps` resolves the project from the checkout;
# everywhere (host or sidecar) label filtering by project works too.
find_container() {
  _svc=$1
  if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && have_compose && [ -f "$REPO_ROOT/docker-compose.yml" ]; then
    _cid=$(cd "$REPO_ROOT" && docker compose ps -q "$_svc" 2>/dev/null | head -n1)
    if [ -n "$_cid" ]; then
      printf '%s\n' "$_cid"
      return 0
    fi
  fi
  _proj=$(project_name)
  if [ -n "$_proj" ]; then
    docker ps -q \
      --filter "label=com.docker.compose.project=$_proj" \
      --filter "label=com.docker.compose.service=$_svc" | head -n1
  else
    docker ps -q --filter "label=com.docker.compose.service=$_svc" | head -n1
  fi
}

require_container() {
  _cid=$(find_container "$1")
  [ -n "$_cid" ] || die "no running '$1' container found for this compose project"
  printf '%s\n' "$_cid"
}

# First network a container is attached to (the compose default network,
# where the 'minio' and 'postgres' service names resolve).
container_network() {
  docker inspect "$1" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    | head -n1
}

# --- Timestamp helpers ------------------------------------------------------
# Backup filenames embed a UTC timestamp: PREFIX-YYYYMMDD-HHMMSS.<ext>.
# to_epoch converts it back without GNU/BSD date quirks (pure arithmetic,
# days-from-civil), so retention behaves identically on Linux, macOS and
# busybox.

to_epoch() {
  _d=${1%%-*} _t=${1##*-}
  [ "${#_d}" -eq 8 ] && [ "${#_t}" -eq 6 ] || return 1
  _y=${_d%????}; _md=${_d#????}; _m=${_md%??}; _dd=${_md#??}
  _H=${_t%????}; _mt=${_t#??}; _M=${_mt%??}; _S=${_mt#??}
  # Strip leading zeros (shell arithmetic would read 08/09 as bad octal).
  _m=${_m#0};  _m=${_m:-0};   _dd=${_dd#0}; _dd=${_dd:-0}
  _H=${_H#0};  _H=${_H:-0};   _M=${_M#0};   _M=${_M:-0};   _S=${_S#0}; _S=${_S:-0}
  _yy=$_y
  [ "$_m" -le 2 ] && _yy=$((_y - 1))
  _era=$((_yy / 400))
  _yoe=$((_yy - _era * 400))
  _mp=$(((_m + 9) % 12))
  _doy=$(((153 * _mp + 2) / 5 + _dd - 1))
  _doe=$((_yoe * 365 + _yoe / 4 - _yoe / 100 + _doy))
  _days=$((_era * 146097 + _doe - 719468))
  printf '%s\n' $((_days * 86400 + _H * 3600 + _M * 60 + _S))
}

# Delete outdated backups matching "$BACKUP_DIR/$2-*.$3" ($2 = file prefix,
# $3 = extension). Keeps files newer than RETENTION_DAILY days, then the
# newest file per 7-day bucket for up to RETENTION_WEEKLY buckets.
apply_retention() {
  _prefix=$1 _ext=$2
  _now=$(date +%s)
  _daily_cutoff=$((_now - RETENTION_DAILY * 86400))
  _seen_buckets=" " _weekly_kept=0
  # sort -r on the zero-padded UTC timestamp = newest first.
  for _f in $(ls -1 "$BACKUP_DIR/${_prefix}"-*".${_ext}" 2>/dev/null | sort -r); do
    _base=${_f##*/}
    _ts=${_base#"${_prefix}"-}
    _ts=${_ts%."${_ext}"}
    _ep=$(to_epoch "$_ts") || { note "keeping unparsable file $_base"; continue; }
    [ "$_ep" -ge "$_daily_cutoff" ] && continue
    _bucket=$((_ep / 604800))
    case $_seen_buckets in
      *" $_bucket "*)
        log "retention: deleting $_base (superseded weekly)"
        rm -f "$_f" ;;
      *)
        if [ "$_weekly_kept" -lt "$RETENTION_WEEKLY" ]; then
          _seen_buckets="$_seen_buckets$_bucket "
          _weekly_kept=$((_weekly_kept + 1))
        else
          log "retention: deleting $_base (beyond $RETENTION_WEEKLY weekly)"
          rm -f "$_f"
        fi ;;
    esac
  done
}
