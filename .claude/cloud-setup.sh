#!/usr/bin/env bash
#
# .claude/cloud-setup.sh: the cloud "Setup script" half of the Claude Code
# environment setup for Sandi.
#
# WHAT THIS IS
#   The toolchain-install half of bootstrapping a Claude Code on the web
#   session. It installs tools the cloud base image does NOT ship but Sandi's
#   dev loop needs. It is wired into the cloud environment's "Setup script"
#   field with a one-line guarded bootstrap:
#
#       if [ -f .claude/cloud-setup.sh ]; then bash .claude/cloud-setup.sh; fi
#
#   The Setup script runs before Claude Code launches and may re-run on any
#   fresh session (after you change this script or the network allowlist, and
#   periodically), so every step is idempotent and cheap on the no-op path: the
#   `command -v <tool>` guard makes an already-installed tool a fast skip.
#
# SCOPE
#   Cloud only, Ubuntu only. The cloud image is Ubuntu 24.04 and the script runs
#   as root, so we use apt and /usr/local/bin freely. Local dev does NOT run
#   this; bootstrap.mjs is the cross-platform half. If invoked somewhere without
#   apt, it no-ops rather than erroring.
#
# WHAT SANDI NEEDS THAT THE BASE IMAGE LACKS
#   The base image already ships node, npm, docker+compose, and the language
#   registries, so Sandi's TypeScript toolchain (installed from package.json via
#   bootstrap.mjs's `npm install`) needs nothing extra here. The one genuine gap
#   is `gh`: the GitHub surface shells out to an already-authenticated `gh` CLI
#   (see SANDI_GH_COMMAND in .env.example and src/surfaces/github/). We install
#   it from the GitHub release tarball, whose host is on the Trusted allowlist.

set -euo pipefail

log() { printf '[cloud-setup] %s\n' "$*"; }

# Ubuntu/apt only. Anywhere else (e.g. a curious local run on macOS), do nothing.
if ! command -v apt-get >/dev/null 2>&1; then
  log "apt-get not found; this script targets the Ubuntu cloud image only. Skipping."
  exit 0
fi

# Map uname -> the arch slugs release artifacts use.
case "$(uname -m)" in
  x86_64)  GH_ARCH=amd64 ;;
  aarch64) GH_ARCH=arm64 ;;
  *)       GH_ARCH="" ;;
esac

# --- gh (GitHub CLI, from the published release tarball) --------------------
# The one tool the base image is consistently missing, and one Sandi's GitHub
# surface depends on. We pull the release asset from github.com rather than the
# cli.github.com apt repo because the GitHub release-asset hosts are on the
# Trusted allowlist and cli.github.com is not. The surface still needs the CLI
# authenticated out of band (`gh auth login`, or a GH_TOKEN in the environment);
# this only installs the binary.
if command -v gh >/dev/null 2>&1; then
  log "gh already present ($(gh --version | head -1)); skipping."
elif [ -z "$GH_ARCH" ]; then
  log "unsupported arch '$(uname -m)' for the gh release tarball; skipping gh."
else
  log "installing gh from its GitHub release..."
  # Resolve the latest tag in two steps (curl into a variable, THEN grep) rather
  # than `curl | grep -m1`. Under `set -o pipefail`, piping straight into
  # `grep -m1` is a race: grep exits on the first match and closes the pipe while
  # curl is still writing the (large) JSON body, so curl dies on SIGPIPE with
  # exit 23 and pipefail+`set -e` turn that into a fatal abort. Buffering the
  # body first lets curl finish cleanly before grep runs.
  ghmeta="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest)"
  ghver="$(printf '%s' "$ghmeta" | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"
  if [ -z "$ghver" ]; then
    log "could not determine the latest gh release tag; skipping gh."
  else
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/gh.tar.gz" \
      "https://github.com/cli/cli/releases/download/v${ghver}/gh_${ghver}_linux_${GH_ARCH}.tar.gz"
    tar -xzf "$tmp/gh.tar.gz" -C "$tmp"
    install -m 0755 "$tmp/gh_${ghver}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh
    rm -rf "$tmp"
    log "installed $(gh --version | head -1)"
  fi
fi

log "done."
