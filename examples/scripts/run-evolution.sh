#!/bin/bash
# run-evolution.sh — Trigger an evolution run for a target skill
#
# Usage:
#   ./run-evolution.sh <skill-name> [generations]
#
# Examples:
#   ./run-evolution.sh weather
#   ./run-evolution.sh weather 10
#   ./run-evolution.sh web-search 5
#
# Requirements:
#   - openclaw CLI must be in PATH
#   - plugin config must exist at ~/.openclaw/plugins/openclaw-self-evolution/config.json
#     (or pass --config to override)

set -euo pipefail

SKILL_NAME="${1:-}"
GENERATIONS="${2:-5}"

if [[ -z "$SKILL_NAME" ]]; then
  echo "Usage: $0 <skill-name> [generations]"
  echo ""
  echo "Arguments:"
  echo "  skill-name   Name of the skill to evolve (e.g., weather, web-search)"
  echo "  generations  Number of evolution generations (default: 5)"
  exit 1
fi

echo "Starting evolution for skill: $SKILL_NAME ($GENERATIONS generations)"

openclaw evolution run \
  --skill "$SKILL_NAME" \
  --generations "$GENERATIONS"

echo ""
echo "Evolution run triggered successfully."
echo "Check status with: openclaw evolution status --skill $SKILL_NAME"
echo "View logs at: ~/.openclaw/plugins/openclaw-self-evolution/.data/evolution-runs/"
