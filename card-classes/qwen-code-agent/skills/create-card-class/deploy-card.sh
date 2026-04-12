#!/bin/bash
# Create a card instance on the canvas
# Usage: deploy-card.sh <name> [instance-name]
# Example: deploy-card.sh moon-orbit moon-demo

set -euo pipefail

NAME="${1:?Usage: deploy-card.sh <name> [instance-name]}"
INSTANCE="${2:-${NAME}}"
API="${MICA_API_URL:?MICA_API_URL not set}"
PROJECT="${MICA_PROJECT:?MICA_PROJECT not set}"

RESULT=$(curl -s -X POST "${API}/api/projects/${PROJECT}/canvases/_root/cards" \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"${INSTANCE}.${NAME}\"}")

OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")

if [ "$OK" = "True" ]; then
  echo "Deployed: ${INSTANCE}.${NAME} on canvas"
else
  echo "Deploy failed:"
  echo "$RESULT"
  exit 1
fi
