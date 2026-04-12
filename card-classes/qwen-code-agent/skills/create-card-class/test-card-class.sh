#!/bin/bash
# Test a card class renders without errors
# Usage: test-card-class.sh <name>

set -euo pipefail

NAME="${1:?Usage: test-card-class.sh <name>}"
API="${MICA_API_URL:?MICA_API_URL not set}"

RESULT=$(curl -s -X POST "${API}/api/card-classes/${NAME}/test" \
  -H 'Content-Type: application/json' \
  -d '{"content":"{}"}')

OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")
ERROR=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null || echo "")

if [ "$OK" = "True" ]; then
  echo "PASS: Card class '${NAME}' renders without errors"
else
  echo "FAIL: Card class '${NAME}' has errors:"
  echo "  ${ERROR}"
  exit 1
fi
