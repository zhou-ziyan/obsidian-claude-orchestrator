#!/bin/bash
set -euo pipefail

# Install node-pty native dependency for Claude Orchestrator.
#
# Usage:
#   bash install.sh "/path/to/your/vault"
#   bash install.sh   # auto-detects if run from plugin directory

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

plugin_dir=""

if [[ $# -ge 1 ]]; then
  plugin_dir="$1/.obsidian/plugins/claude-orchestrator"
elif [[ -f "manifest.json" ]] && grep -q '"claude-orchestrator"' manifest.json 2>/dev/null; then
  plugin_dir="$(pwd)"
else
  echo -e "${RED}Error:${NC} Please provide your vault path:"
  echo "  bash install.sh \"/path/to/your/vault\""
  exit 1
fi

if [[ ! -d "$plugin_dir" ]]; then
  echo -e "${RED}Error:${NC} Plugin directory not found: $plugin_dir"
  echo "Make sure Claude Orchestrator is installed via BRAT first."
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo -e "${RED}Error:${NC} npm is not installed."
  echo "Install Node.js from https://nodejs.org/ (LTS recommended)."
  exit 1
fi

if ! command -v tmux &>/dev/null; then
  echo -e "${YELLOW}Warning:${NC} tmux is not installed. The plugin requires tmux to run."
  case "$(uname -s)" in
    Darwin) echo "  Install with: brew install tmux" ;;
    Linux)  echo "  Install with: sudo apt install tmux  (or your package manager)" ;;
  esac
fi

echo "Installing node-pty in $plugin_dir ..."
cd "$plugin_dir"

case "$(uname -s)" in
  Darwin)  platform="macOS ($(uname -m))" ;;
  Linux)   platform="Linux ($(uname -m))" ;;
  *)       platform="$(uname -s) ($(uname -m))" ;;
esac
echo "Platform: $platform"

if npm install node-pty 2>&1; then
  echo ""
  echo -e "${GREEN}Done!${NC} node-pty installed successfully."
  echo "Restart Obsidian to load the plugin."
else
  echo ""
  echo -e "${RED}Failed to install node-pty.${NC}"
  echo ""
  echo "Common fixes:"
  echo "  - macOS: xcode-select --install  (installs build tools)"
  echo "  - Linux: sudo apt install build-essential python3"
  echo "  - Make sure you have Node.js >= 18"
  exit 1
fi
