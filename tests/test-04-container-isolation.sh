#!/bin/bash
# Test 4: Per-Project Container Isolation
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 04: Container Isolation ==="
echo ""

if ! command -v docker &>/dev/null; then
  echo "SKIP: Docker not available."
  exit 0
fi

setup_test_dir

PROJ_A_DIR="$TEST_DIR/container-alpha"
PROJ_B_DIR="$TEST_DIR/container-beta"
PROJ_A="container-alpha"
PROJ_B="container-beta"

# Clean slate
cleanup_projects "$PROJ_A" "$PROJ_B"

# Setup: connect two projects with app.py
for dir in "$PROJ_A_DIR" "$PROJ_B_DIR"; do
  mkdir -p "$dir"
  cat > "$dir/app.py" << 'PYEOF'
import http.server
http.server.HTTPServer(("", 8080), http.server.SimpleHTTPRequestHandler).serve_forever()
PYEOF
done

api_post "/projects/connect" "{\"path\":\"$PROJ_A_DIR\",\"name\":\"Container Alpha\"}" >/dev/null
api_post "/projects/connect" "{\"path\":\"$PROJ_B_DIR\",\"name\":\"Container Beta\"}" >/dev/null

# ── 4a: Start a container ────────────────────────────────
echo "4a. Start container..."
RESP=$(api_post "/projects/$PROJ_A/container/start")
STATUS=$(echo "$RESP" | json_get "['status']")
check "Container started" "$STATUS" "running"

CONTAINER_NAME=$(echo "$RESP" | json_get "['containerName']")
check "Container name correct" "$CONTAINER_NAME" "mica-app-$PROJ_A"

# Verify in docker ps
IN_DOCKER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c "$CONTAINER_NAME" || true)
check "Visible in docker ps" "$([ "$IN_DOCKER" -ge 1 ] && echo yes || echo no)" "yes"

# ── 4b: Container status ─────────────────────────────────
echo ""
echo "4b. Container status..."
STATUS_RESP=$(api_get "/projects/$PROJ_A/container/status")
RUNNING=$(echo "$STATUS_RESP" | json_get "['running']")
check "Status shows running" "$RUNNING" "True"

STATUS_STR=$(echo "$STATUS_RESP" | json_get "['status']")
check "Status string is running" "$STATUS_STR" "running"

# ── 4c: Container logs ───────────────────────────────────
echo ""
echo "4c. Container logs..."
# Give the container a moment to produce output
sleep 1
LOGS=$(api_get "/projects/$PROJ_A/container/logs?tail=10")
# Logs endpoint should return without error (content may be empty)
check "Logs endpoint returns" "$([ -n "$LOGS" ] && echo yes || echo no)" "yes"
ok "Logs retrieved"

# ── 4d: Stop container ───────────────────────────────────
echo ""
echo "4d. Stop container..."
api_post "/projects/$PROJ_A/container/stop" >/dev/null

# Verify gone from docker ps
sleep 1
IN_DOCKER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c "mica-app-$PROJ_A" || true)
check "Removed from docker ps" "$IN_DOCKER" "0"

# Status should show not running
STATUS_RESP=$(api_get "/projects/$PROJ_A/container/status")
RUNNING=$(echo "$STATUS_RESP" | json_get "['running']")
check "Status shows not running" "$RUNNING" "False"

# ── 4e: Cross-project isolation ──────────────────────────
echo ""
echo "4e. Cross-project isolation..."

# Start both
RESP_A=$(api_post "/projects/$PROJ_A/container/start")
RESP_B=$(api_post "/projects/$PROJ_B/container/start")

STATUS_A=$(echo "$RESP_A" | json_get "['status']")
STATUS_B=$(echo "$RESP_B" | json_get "['status']")
check "Alpha started" "$STATUS_A" "running"
check "Beta started" "$STATUS_B" "running"

# Different container names
NAME_A=$(echo "$RESP_A" | json_get "['containerName']")
NAME_B=$(echo "$RESP_B" | json_get "['containerName']")
check "Different container names" "$([ "$NAME_A" != "$NAME_B" ] && echo yes || echo no)" "yes"

# Different port allocations
PORT_A=$(echo "$RESP_A" | python3 -c "import sys,json; ports=json.load(sys.stdin).get('ports',[]); print(ports[0]['host'] if ports else 'none')")
PORT_B=$(echo "$RESP_B" | python3 -c "import sys,json; ports=json.load(sys.stdin).get('ports',[]); print(ports[0]['host'] if ports else 'none')")
if [ "$PORT_A" != "none" ] && [ "$PORT_B" != "none" ]; then
  check "Different host ports" "$([ "$PORT_A" != "$PORT_B" ] && echo yes || echo no)" "yes"
fi

# Stop one, other keeps running
api_post "/projects/$PROJ_A/container/stop" >/dev/null
sleep 1

B_STILL_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c "mica-app-$PROJ_B" || true)
check "Beta still running after Alpha stopped" "$([ "$B_STILL_RUNNING" -ge 1 ] && echo yes || echo no)" "yes"

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."
api_post "/projects/$PROJ_B/container/stop" >/dev/null 2>&1
cleanup_projects "$PROJ_A" "$PROJ_B"
teardown_test_dir
ok "Cleaned up"

summary
