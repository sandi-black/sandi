#!/usr/bin/env bash
# Claude Code cloud environment setup for sandi (Node / TypeScript).
#
# Runs as root on Ubuntu 24.04 before the session starts, per
# https://code.claude.com/docs/en/claude-code-on-the-web#setup-scripts
# Point an environment's Setup script at:  bash scripts/setup-claude-env.sh
#
# Design rules (from the docs):
#   - Never block session start: every step is non-fatal and the script exits 0.
#   - Node 22 is pre-installed via nvm and is the version CI verifies against, so
#     this uses the pre-installed Node directly (no NodeSource: deb.nodesource.com
#     is not allowlisted under Trusted). git is pre-installed too.
#   - No database or external services are needed to build. Running the Discord or
#     GitHub surfaces needs the secrets in .env.example (DISCORD_BOT_TOKEN,
#     SANDI_*); none are needed to install or build.
# Idempotent and cached; safe to re-run.

set -uo pipefail

log()  { printf '==> %s\n' "$1"; }
warn() { printf 'warn: %s\n' "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# The runtime Dockerfile pins Node 26 and CI verifies on Node 22. Prefer a
# pre-installed Node 22 (via nvm) when the active Node is a different major.
if [ "$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')" != "22" ]; then
  for d in "${NVM_DIR:-}" /usr/local/nvm /usr/local/share/nvm "$HOME/.nvm" /root/.nvm; do
    if [ -n "$d" ] && [ -s "$d/nvm.sh" ]; then
      export NVM_DIR="$d"
      # shellcheck disable=SC1091
      . "$d/nvm.sh"
      nvm use 22 >/dev/null 2>&1 || nvm install 22 >/dev/null 2>&1 || true
      break
    fi
  done
fi

command -v node >/dev/null 2>&1 || warn "node not found (expected pre-installed)"
log "Node $(node -v 2>/dev/null), npm $(npm -v 2>/dev/null)"

log "Installing dependencies (npm ci)"
npm ci || warn "npm ci failed (check network access); the session can retry it in-session"

log "Building (npm run build  =>  tsc --noEmit)"
npm run build || warn "npm run build did not finish; the session can build in-session"

log "sandi environment ready"
exit 0
