#!/usr/bin/env bash
# Lemniscate one-command installer for Linux.
# Installs Docker (if missing), clones the repo, prepares env files and
# starts the full stack via Docker Compose. Safe to re-run.
set -euo pipefail

REPO_URL="https://gitverse.ru/grigorii_fedorov/lemniscate.git"
TARGET_DIR="./lemniscate"
HEALTH_URL="http://localhost:3000/health"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "This script needs root or sudo to install packages."
  SUDO="sudo"
fi

# --- Sanity: we really are on Linux ---------------------------------------
step "Checking operating system"
[ "$(uname -s)" = "Linux" ] || die "This script is for Linux. Use install-macos.sh on macOS."
note "Linux detected."

# --- Helpers ---------------------------------------------------------------

# Portable `sed -i` (GNU vs BSD).
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# Detect the system package manager (apt/dnf/pacman/zypper).
pkg_manager() {
  for pm in apt-get dnf pacman zypper; do
    if command -v "$pm" >/dev/null 2>&1; then
      echo "$pm"
      return 0
    fi
  done
  return 1
}

install_git() {
  local pm
  pm=$(pkg_manager) || die "git is missing and no supported package manager (apt/dnf/pacman/zypper) was found."
  step "Installing git via $pm"
  case "$pm" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y git ;;
    dnf)     $SUDO dnf install -y git ;;
    pacman)  $SUDO pacman -Sy --noconfirm git ;;
    zypper)  $SUDO zypper --non-interactive install git ;;
  esac
}

install_docker() {
  step "Installing Docker via the official convenience script"
  note "Using https://get.docker.com (supports apt/dnf/pacman/zypper based distros)."
  curl -fsSL https://get.docker.com | $SUDO sh
  if command -v systemctl >/dev/null 2>&1; then
    step "Enabling and starting the docker service"
    $SUDO systemctl enable --now docker
  fi
  if [ -n "$SUDO" ]; then
    step "Adding $USER to the docker group"
    $SUDO usermod -aG docker "$USER" || true
    note "NOTE: log out and back in (or run 'newgrp docker') for rootless docker access."
    note "This run will fall back to 'sudo docker' where needed."
  fi
}

# DOCKER/COMPOSE commands that work even before the docker group applies.
setup_docker_cmd() {
  DOCKER="docker"
  if ! docker info >/dev/null 2>&1; then
    if [ -n "$SUDO" ] && sudo docker info >/dev/null 2>&1; then
      DOCKER="sudo docker"
    fi
  fi
  COMPOSE="$DOCKER compose"
}

# --- Docker ----------------------------------------------------------------
step "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  install_docker
else
  note "docker found: $(docker --version)"
fi
setup_docker_cmd

step "Checking Docker Compose"
if ! $COMPOSE version >/dev/null 2>&1; then
  pm=$(pkg_manager) || die "Docker Compose plugin missing and no supported package manager found."
  step "Installing the Docker Compose plugin via $pm"
  case "$pm" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y docker-compose-plugin ;;
    dnf)     $SUDO dnf install -y docker-compose-plugin ;;
    pacman)  $SUDO pacman -Sy --noconfirm docker-compose ;;
    zypper)  $SUDO zypper --non-interactive install docker-compose-plugin ;;
  esac
fi
note "compose found: $($COMPOSE version)"

# --- Source code -----------------------------------------------------------
command -v git >/dev/null 2>&1 || install_git
step "Fetching Lemniscate source"
if [ -d "$TARGET_DIR/.git" ]; then
  note "Existing checkout found in $TARGET_DIR — pulling latest changes."
  git -C "$TARGET_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# --- Environment files -----------------------------------------------------
step "Preparing environment files"
[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env ] || cp frontend/.env.example frontend/.env

# Fill JWT_SECRET / ENCRYPTION_KEY with random values when left at defaults.
ensure_secret() {
  local key="$1" file="$2" current
  current=$(grep -E "^${key}=" "$file" | head -n1 | cut -d= -f2- || true)
  if [ -z "$current" ] || [ "${current#change-me}" != "$current" ]; then
    sed_inplace "s|^${key}=.*|${key}=$(openssl rand -hex 32)|" "$file"
    note "Generated a random ${key}."
  else
    note "${key} already set — keeping it."
  fi
}
ensure_secret JWT_SECRET backend/.env
ensure_secret ENCRYPTION_KEY backend/.env

note ""
note "ACTION REQUIRED: edit backend/.env and fill in the OAuth app credentials"
note "(GITHUB_CLIENT_ID/SECRET, GITLAB_CLIENT_ID/SECRET) — see README.md,"
note "section 'OAuth app setup'. GitVerse works with a personal access token"
note "from the UI, no OAuth app needed."

# --- Launch ----------------------------------------------------------------
step "Building and starting Lemniscate (docker compose up -d --build)"
$COMPOSE up -d --build

step "Waiting for the backend to become healthy ($HEALTH_URL)"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    healthy="yes"
    break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  note "Backend did not answer within 60s. Check logs with: $COMPOSE logs backend"
  exit 1
fi

step "Lemniscate is up!"
cat <<EOF

    Frontend:  http://localhost:8080
    Backend:   http://localhost:3000

    Register these OAuth callback URLs at your providers:
      GitHub:  http://localhost:3000/api/auth/github/callback
      GitLab:  http://localhost:3000/api/auth/gitlab/callback

    Useful commands (run inside $TARGET_DIR):
      $COMPOSE logs -f        # follow logs
      $COMPOSE down           # stop everything
EOF
