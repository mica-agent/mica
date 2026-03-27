#!/bin/bash
# Run all Mica integration tests
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_RUN=0
SCRIPTS_FAILED=0
FAILED_NAMES=()

echo "===== Mica Integration Test Suite ====="
echo ""

for test in "$SCRIPT_DIR"/tests/test-*.sh; do
  name=$(basename "$test")
  echo "────── $name ──────"
  if bash "$test"; then
    ((SCRIPTS_RUN++))
  else
    ((SCRIPTS_RUN++))
    ((SCRIPTS_FAILED++))
    FAILED_NAMES+=("$name")
  fi
  echo ""
done

echo "===== SUITE SUMMARY ====="
echo "  Scripts run:    $SCRIPTS_RUN"
echo "  Scripts passed: $((SCRIPTS_RUN - SCRIPTS_FAILED))"
echo "  Scripts failed: $SCRIPTS_FAILED"
if [ ${#FAILED_NAMES[@]} -gt 0 ]; then
  echo "  Failed:"
  for f in "${FAILED_NAMES[@]}"; do
    echo "    - $f"
  done
fi
echo "========================="

exit "$SCRIPTS_FAILED"
