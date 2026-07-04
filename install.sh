#!/usr/bin/env bash
# Akorith CLI installer — host this at https://akorith.space/install so users
# can run:  curl -fsSL https://akorith.space/install | bash
set -euo pipefail

bold=$(tput bold 2>/dev/null || true)
dim=$(tput dim 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

echo "${bold}Akorith CLI installer${reset}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org and re-run."
  exit 1
fi

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node -v)). Upgrade and re-run."
  exit 1
fi

echo "${dim}Installing akorith via npm...${reset}"
npm install -g akorith

echo ""
echo "${bold}Done.${reset} Type ${bold}akorith${reset} in any terminal to start."
echo "${dim}Akorith drives the agent CLIs you already have — for the full experience install"
echo "one or more of: claude (claude.com/claude-code), codex (openai.com/codex),"
echo "opencode (opencode.ai).${reset}"
