#!/usr/bin/env bash
# Lemniscate LOCAL one-command installer.
# Installs a standalone local instance (own DB/login, separate from any cloud
# deploy) under ~/.lemniscate-local and starts it via deploy/local/docker-compose.yml.
# Idempotent — safe to re-run; a re-run pulls the latest code and rebuilds (upgrade path).
set -euo pipefail

REPO_URL="https://github.com/grig-teo/lemniscate.git"
TARGET_DIR="$HOME/.lemniscate-local"
COMPOSE_FILE="deploy/local/docker-compose.yml"
ENV_FILE="deploy/local/.env"
ENV_EXAMPLE="deploy/local/.env.example"
DEFAULT_PUBLIC_URL="http://localhost:8280"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# Portable `sed -i` (GNU vs BSD).
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# Read one KEY=value from an env file (empty when missing).
env_value() {
  grep -E "^$1=" "$2" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# Fill KEY with a random hex secret when unset or still a change-me placeholder.
ensure_secret() {
  local key="$1" current
  current=$(env_value "$key" "$ENV_FILE")
  if [ -z "$current" ] || [ "${current#change-me}" != "$current" ]; then
    sed_inplace "s|^${key}=.*|${key}=$(openssl rand -hex 32)|" "$ENV_FILE"
    note "Generated a random ${key}."
  else
    note "${key} already set — keeping it."
  fi
}

# --- Docker ---------------------------------------------------------------
step "Checking Docker"
command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux), then re-run."
docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker and re-run."
note "docker found: $(docker --version)"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing — update/reinstall Docker."
note "compose found: $(docker compose version)"

# --- Source code ----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is missing — install it and re-run."
step "Fetching Lemniscate source into $TARGET_DIR"
if [ -d "$TARGET_DIR/.git" ]; then
  note "Existing checkout found — pulling latest changes."
  git -C "$TARGET_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# --- Configuration ----------------------------------------------------------
step "Preparing configuration ($ENV_FILE)"
first_run=""
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  first_run="yes"
  note "Created $ENV_FILE from the example."
fi
ensure_secret POSTGRES_PASSWORD
ensure_secret MINIO_ROOT_PASSWORD
ensure_secret JWT_SECRET
ensure_secret ENCRYPTION_KEY

# Public URL: how this machine is reached — by you in the browser and by
# devices pairing over LAN. Prompted on first run, kept on upgrades.
public_url=$(env_value PUBLIC_URL "$ENV_FILE")
if [ -n "$first_run" ]; then
  lan_ip=$( (ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') || true)
  default_url="$DEFAULT_PUBLIC_URL"
  [ -n "$lan_ip" ] && default_url="http://${lan_ip}:8280"
  printf '\n    Public URL for this instance [%s]: ' "$default_url"
  answer=""
  if [ -t 0 ] || [ -e /dev/tty ]; then
    read -r answer </dev/tty || answer=""
  fi
  public_url="${answer:-$default_url}"
  sed_inplace "s|^PUBLIC_URL=.*|PUBLIC_URL=${public_url}|" "$ENV_FILE"
fi
note "PUBLIC_URL=$public_url"

# --- Launch -----------------------------------------------------------------
step "Building and starting the local instance (docker compose up -d --build)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

frontend_port=$(env_value FRONTEND_PORT "$ENV_FILE")
frontend_port="${frontend_port:-8280}"
health_url="http://localhost:${frontend_port}"
step "Waiting for the UI to respond ($health_url)"
healthy=""
for _ in $(seq 1 90); do
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    healthy="yes"
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  note "The UI did not answer within 3 minutes."
  note "Check logs with: cd $TARGET_DIR && docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs"
  exit 1
fi

step "Lemniscate LOCAL is up!"
cat <<EOF

    Open the UI:        $public_url

    Next steps:
      1) Create your account (this instance has its own DB/login).
      2) Settings → add an LLM config (a local Ollama works too) and
         connect a git host (personal access token works everywhere).
      3) Pair devices: click "+" in the Devices strip and run the shown
         command on the device — it must reach $public_url,
         so open the UI via the LAN URL when pairing phones on your Wi-Fi.

    Useful commands (run inside $TARGET_DIR):
      docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs -f   # follow logs
      docker compose --env-file $ENV_FILE -f $COMPOSE_FILE down      # stop
      bash scripts/install-local.sh                                  # upgrade (pull + rebuild)
EOF
