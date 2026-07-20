#!/usr/bin/env bash
# Lemniscate one-command installer for macOS.
# Installs Docker Desktop (if missing), clones the repo, prepares env files
# and starts the full stack via Docker Compose. Safe to re-run.
set -euo pipefail

REPO_URL="https://gitverse.ru/grigorii_fedorov/lemniscate.git"
TARGET_DIR="./lemniscate"
HEALTH_URL="http://localhost:3000/health"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# --- Sanity: we really are on macOS ---------------------------------------
step "Checking operating system"
[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. Use install-linux.sh on Linux."
note "macOS detected."

# --- Helpers ---------------------------------------------------------------

# Portable `sed -i` (GNU vs BSD).
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

install_docker() {
  if command -v brew >/dev/null 2>&1; then
    step "Installing Docker Desktop via Homebrew"
    brew install --cask docker
  else
    cat <<'EOF'

    Homebrew is not installed. Pick one:
      1) Install Homebrew from https://brew.sh, then re-run this script, or
      2) Download and install Docker Desktop manually:
         https://www.docker.com/products/docker-desktop/

EOF
    # When run interactively, offer to install Homebrew automatically.
    if [ -t 0 ] || [ -e /dev/tty ]; then
      printf '    Install Homebrew now? [y/N] '
      read -r answer </dev/tty || answer=""
      if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Apple Silicon puts brew in /opt/homebrew; Intel in /usr/local.
        [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
        command -v brew >/dev/null 2>&1 || die "Homebrew installed but 'brew' is not on PATH. Open a new shell and re-run."
        step "Installing Docker Desktop via Homebrew"
        brew install --cask docker
        return 0
      fi
    fi
    exit 1
  fi
}

wait_for_docker() {
  step "Waiting for Docker Desktop to start"
  note "Launching Docker Desktop — approve any macOS prompts if they appear."
  open -a Docker >/dev/null 2>&1 || note "Could not auto-launch Docker; please open Docker Desktop manually."
  for _ in $(seq 1 120); do
    if docker info >/dev/null 2>&1; then
      note "Docker daemon is up."
      return 0
    fi
    sleep 2
  done
  die "Docker did not become ready within 4 minutes. Start Docker Desktop and re-run."
}

# --- Docker ----------------------------------------------------------------
step "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  install_docker
else
  note "docker found: $(docker --version)"
fi
docker info >/dev/null 2>&1 || wait_for_docker

step "Checking Docker Compose"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing — update/reinstall Docker Desktop."
note "compose found: $(docker compose version)"

# --- Source code -----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is missing. Run 'xcode-select --install' and re-run."
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
docker compose up -d --build

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
  note "Backend did not answer within 60s. Check logs with: docker compose logs backend"
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
      docker compose logs -f        # follow logs
      docker compose down           # stop everything
EOF
