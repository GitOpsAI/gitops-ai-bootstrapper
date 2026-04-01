#!/usr/bin/env bash
set -euo pipefail

OS="$(uname -s)"

BOLD='\033[1m'
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

log() { printf "\n${BOLD}${CYAN}==> %s${RESET}\n" "$1"; }
ok()  { printf "${GREEN}  ✔ %s${RESET}\n" "$1"; }
err() { printf "${RED}  ✖ %s${RESET}\n" "$1" >&2; }

# ---------------------------------------------------------------------------
# Ensure Node.js >= 18
# ---------------------------------------------------------------------------

log "Checking prerequisites"

if [[ "$OS" == "Darwin" ]] && ! command -v brew &>/dev/null; then
  err "Homebrew is required on macOS. Install from https://brew.sh"
  exit 1
fi

if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0] >= 18))')" != "true" ]; then
  log "Installing Node.js"
  if [[ "$OS" == "Darwin" ]]; then
    brew install node
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs > /dev/null
  fi
fi
ok "node $(node --version)"

# ---------------------------------------------------------------------------
# Launch the CLI via npx (downloads from npm if not cached)
# ---------------------------------------------------------------------------

log "Starting Flux CLI"
exec npx gitops-ai bootstrap < /dev/tty
