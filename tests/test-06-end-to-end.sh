#!/bin/bash
# Test 6: End-to-End Workflow
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 06: End-to-End Workflow ==="
echo ""
setup_test_dir

PROJ_DIR="$TEST_DIR/e2e-project"
PROJ_ID="e2e-project"
HAS_DOCKER=$(command -v docker &>/dev/null && echo yes || echo no)

# Clean slate
cleanup_projects "$PROJ_ID"

# ── Step 1: Connect fresh directory ───────────────────────
echo "1. Connect project..."
mkdir -p "$PROJ_DIR"
RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_DIR\",\"name\":\"E2E Project\"}")
CONN_ID=$(echo "$RESP" | json_get "['id']")
check "Project connected" "$CONN_ID" "$PROJ_ID"

# ── Step 2: Write agent brief ────────────────────────────
echo ""
echo "2. Configure agent brief..."
api_put "/projects/$PROJ_ID/canvases/workspace/files/_brief.brief" \
  '{"content":"You are a test agent for e2e validation."}' >/dev/null
BRIEF=$(api_get "/projects/$PROJ_ID/canvases/workspace/files/_brief.brief" | json_get "['content']")
check "Brief written" "$BRIEF" "You are a test agent for e2e validation."

# ── Step 3: Create app file ──────────────────────────────
echo ""
echo "3. Create application file..."
cat > "$PROJ_DIR/app.py" << 'PYEOF'
import http.server
http.server.HTTPServer(("", 8080), http.server.SimpleHTTPRequestHandler).serve_forever()
PYEOF
check "app.py created" "$(test -f $PROJ_DIR/app.py && echo yes || echo no)" "yes"

# ── Step 4: Start container ──────────────────────────────
echo ""
echo "4. Container..."
if [ "$HAS_DOCKER" = "yes" ]; then
  RESP=$(api_post "/projects/$PROJ_ID/container/start")
  STATUS=$(echo "$RESP" | json_get "['status']")
  check "Container started" "$STATUS" "running"

  HOST_PORT=$(echo "$RESP" | python3 -c "import sys,json; ports=json.load(sys.stdin).get('ports',[]); print(ports[0]['host'] if ports else 'none')")
  if [ "$HOST_PORT" != "none" ]; then
    # Give container a moment to start serving
    sleep 2
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$HOST_PORT/" 2>/dev/null || echo "000")
    check "App accessible on port $HOST_PORT" "$([ "$HTTP_CODE" = "200" ] && echo yes || echo no)" "yes"
  fi
else
  echo "  SKIP: Docker not available"
fi

# ── Step 5: Simulate agent work (modify app) ─────────────
echo ""
echo "5. Simulate agent modifying app..."
cat > "$PROJ_DIR/app.py" << 'PYEOF'
import http.server
import json

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
        else:
            super().do_GET()

http.server.HTTPServer(("", 8080), Handler).serve_forever()
PYEOF
check "app.py modified" "$(grep -c 'api/status' $PROJ_DIR/app.py)" "1"

# ── Step 6: Commit the change ────────────────────────────
echo ""
echo "6. Git commit..."
RESP=$(api_post "/projects/$PROJ_ID/git/commit" '{"message":"Add status endpoint"}')
HAS_HASH=$(echo "$RESP" | json_has_key "hash")
check "Commit succeeded" "$HAS_HASH" "yes"

# ── Step 7: Verify git log ───────────────────────────────
echo ""
echo "7. Git log..."
LOG=$(api_get "/projects/$PROJ_ID/git/log?limit=5")
LOG_LEN=$(echo "$LOG" | json_len)
check "Log has commits" "$([ "$LOG_LEN" -ge 1 ] && echo yes || echo no)" "yes"

LAST_MSG=$(echo "$LOG" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['message'])")
check "Last commit message" "$LAST_MSG" "Add status endpoint"

# ── Step 8: Stop container ───────────────────────────────
echo ""
echo "8. Stop container..."
if [ "$HAS_DOCKER" = "yes" ]; then
  api_post "/projects/$PROJ_ID/container/stop" >/dev/null
  ok "Container stopped"
else
  echo "  SKIP: Docker not available"
fi

# ── Step 9: Disconnect ───────────────────────────────────
echo ""
echo "9. Disconnect..."
api_post "/projects/$PROJ_ID/disconnect" >/dev/null
IN_LIST=$(api_get "/projects" | python3 -c "
import sys, json
ids = [p['id'] for p in json.load(sys.stdin)]
print('yes' if '$PROJ_ID' in ids else 'no')
")
check "Disconnected from registry" "$IN_LIST" "no"

# ── Step 10: Reconnect ───────────────────────────────────
echo ""
echo "10. Reconnect..."
RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_DIR\"}")
CONN_ID=$(echo "$RESP" | json_get "['id']")
check "Reconnected" "$CONN_ID" "$PROJ_ID"

# ── Step 11: Verify metadata preserved ───────────────────
echo ""
echo "11. Verify metadata preserved..."
BRIEF=$(api_get "/projects/$PROJ_ID/canvases/workspace/files/_brief.brief" | json_get "['content']")
check "Brief preserved after reconnect" "$BRIEF" "You are a test agent for e2e validation."

LOG=$(api_get "/projects/$PROJ_ID/git/log?limit=5")
LAST_MSG=$(echo "$LOG" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['message'])")
check "Git history preserved" "$LAST_MSG" "Add status endpoint"

# ── Step 12: Restart container ───────────────────────────
echo ""
echo "12. Restart container after reconnect..."
if [ "$HAS_DOCKER" = "yes" ]; then
  RESP=$(api_post "/projects/$PROJ_ID/container/start")
  STATUS=$(echo "$RESP" | json_get "['status']")
  check "Container restarted" "$STATUS" "running"
  api_post "/projects/$PROJ_ID/container/stop" >/dev/null
  ok "Container stopped again"
else
  echo "  SKIP: Docker not available"
fi

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."
cleanup_projects "$PROJ_ID"
teardown_test_dir
ok "Cleaned up"

summary
