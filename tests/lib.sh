#!/bin/bash
# Shared test helpers for Mica integration tests

API="${MICA_API:-http://localhost:3001/api}"
TEST_DIR="/tmp/mica-test-$(date +%s)"
PASS=0
FAIL=0

ok()   { echo "  PASS: $1"; ((PASS++)); }
fail() { echo "  FAIL: $1"; ((FAIL++)); }
check() {
  # usage: check "description" <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got '$2', expected '$3')"; fi
}

# JSON helpers (pipe curl output into these)
json_get() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)" 2>/dev/null; }
json_len() { python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null; }
json_has_key() { python3 -c "import sys,json; print('yes' if '$1' in json.load(sys.stdin) else 'no')" 2>/dev/null; }

# HTTP helpers
api_get()  { curl -s "$API$1"; }
api_post() { local body="${2:-"{}"}"; curl -s -X POST "$API$1" -H "Content-Type: application/json" -d "$body"; }
api_put()  { curl -s -X PUT "$API$1" -H "Content-Type: application/json" -d "$2"; }
api_delete() { curl -s -X DELETE "$API$1"; }

# Cleanup helpers
cleanup_projects() {
  for proj in "$@"; do
    curl -s -X POST "$API/projects/$proj/container/stop" >/dev/null 2>&1 || true
    curl -s -X POST "$API/projects/$proj/disconnect" >/dev/null 2>&1 || true
  done
}

setup_test_dir() {
  mkdir -p "$TEST_DIR"
}

teardown_test_dir() {
  rm -rf "$TEST_DIR"
}

summary() {
  echo ""
  echo "==============================="
  echo "  PASSED: $PASS"
  echo "  FAILED: $FAIL"
  echo "==============================="
  [ "$FAIL" -eq 0 ] && return 0 || return 1
}
