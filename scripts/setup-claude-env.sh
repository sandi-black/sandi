#!/usr/bin/env bash
set -euo pipefail

# setup-claude-env.sh
#
# Provision a fresh Claude Code cloud environment for sandi (Node / TypeScript).
# Targets a Debian/Ubuntu Linux container that starts with nothing installed.
# Idempotent: safe to re-run. Invoke as: ./scripts/setup-claude-env.sh
#
# What it does:
#   - installs Node.js 22 (the version the CI check suite runs on) and git
#   - installs dependencies with `npm ci`
#   - runs the build (`npm run build`, which is `tsc --noEmit`)
#
# Notes:
#   - The runtime Dockerfile pins Node 26; CI verifies against Node 22, so this
#     script matches CI. Override NODE_MAJOR below if you need the runtime version.
#   - The app runs from source via tsx; there is no transpiled artifact.
#   - No database or external services are needed to build. Running the Discord
#     or GitHub surfaces needs the secrets in .env.example (DISCORD_BOT_TOKEN,
#     SANDI_*, etc.); none are needed to install or build.

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { printf "${GREEN}==>${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}warn:${NC} %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NODE_MAJOR=22

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

apt_install() {
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found; please install manually: $*"
    return 0
  fi
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

log "Installing prerequisites (git, curl, ca-certificates)"
apt_install git ca-certificates curl

if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')" != "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    apt_install nodejs
  else
    warn "apt-get unavailable; please install Node.js ${NODE_MAJOR} manually"
  fi
fi

log "Node $(node -v 2>/dev/null), npm $(npm -v 2>/dev/null)"

log "Installing dependencies (npm ci)"
npm ci

log "Building (npm run build)"
npm run build

log "sandi environment ready"
