#!/bin/bash
# Test 1: Project Connection Lifecycle
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 01: Connection Lifecycle ==="
echo ""
setup_test_dir

PROJ_A="$TEST_DIR/project-alpha"
PROJ_B="$TEST_DIR/project-beta"

# Clean slate
cleanup_projects project-alpha project-beta

# ── 1a: Connect a fresh directory ─────────────────────────
echo "1a. Connect fresh directory..."
mkdir -p "$PROJ_A"

RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_A\",\"name\":\"Project Alpha\"}")
CONN_ID=$(echo "$RESP" | json_get "['id']")
check "Connect returns id" "$CONN_ID" "project-alpha"

check ".mica/ exists" "$(test -d $PROJ_A/.mica && echo yes || echo no)" "yes"
check "config.json exists" "$(test -f $PROJ_A/.mica/config.json && echo yes || echo no)" "yes"
check "workspace/ dir exists" "$(test -d $PROJ_A/.mica/workspace && echo yes || echo no)" "yes"
check ".git/ initialized" "$(test -d $PROJ_A/.git && echo yes || echo no)" "yes"

# Verify in project list
IN_LIST=$(api_get "/projects" | python3 -c "
import sys, json
ids = [p['id'] for p in json.load(sys.stdin)]
print('yes' if 'project-alpha' in ids else 'no')
")
check "Appears in project list" "$IN_LIST" "yes"

# ── 1b: Connect an existing git repo ─────────────────────
echo ""
echo "1b. Connect existing git repo..."
mkdir -p "$PROJ_B"
git -C "$PROJ_B" init -q
echo "hello" > "$PROJ_B/README.md"
git -C "$PROJ_B" add README.md
git -C "$PROJ_B" commit -q -m "initial"
ORIG_HASH=$(git -C "$PROJ_B" rev-parse HEAD)

RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_B\",\"name\":\"Project Beta\"}")
CONN_ID=$(echo "$RESP" | json_get "['id']")
check "Connect existing repo returns id" "$CONN_ID" "project-beta"

check ".mica/ created" "$(test -d $PROJ_B/.mica && echo yes || echo no)" "yes"

# Verify git was NOT re-initialized (original commit preserved)
CURRENT_HASH=$(git -C "$PROJ_B" rev-parse HEAD)
check "Original git history preserved" "$CURRENT_HASH" "$ORIG_HASH"

# Verify README untouched
README_CONTENT=$(cat "$PROJ_B/README.md")
check "README.md untouched" "$README_CONTENT" "hello"

# ── 1c: Disconnect ────────────────────────────────────────
echo ""
echo "1c. Disconnect..."
RESP=$(api_post "/projects/project-alpha/disconnect")
SUCCESS=$(echo "$RESP" | json_has_key "success")
check "Disconnect returns success" "$SUCCESS" "yes"

# Verify removed from registry
IN_LIST=$(api_get "/projects" | python3 -c "
import sys, json
ids = [p['id'] for p in json.load(sys.stdin)]
print('yes' if 'project-alpha' in ids else 'no')
")
check "Removed from project list" "$IN_LIST" "no"

# Verify .mica/ preserved on disk
check ".mica/ still on disk" "$(test -d $PROJ_A/.mica && echo yes || echo no)" "yes"
check "config.json still on disk" "$(test -f $PROJ_A/.mica/config.json && echo yes || echo no)" "yes"

# ── 1d: Reconnect ─────────────────────────────────────────
echo ""
echo "1d. Reconnect..."
RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_A\"}")
CONN_ID=$(echo "$RESP" | json_get "['id']")
check "Reconnect returns id" "$CONN_ID" "project-alpha"

# Verify picks up existing config (name preserved)
CONFIG_NAME=$(python3 -c "import json; print(json.load(open('$PROJ_A/.mica/config.json'))['name'])")
check "Config name preserved" "$CONFIG_NAME" "Project Alpha"

# ── 1e: Duplicate connection rejected ─────────────────────
echo ""
echo "1e. Duplicate connection..."
RESP=$(api_post "/projects/connect" "{\"path\":\"$PROJ_A\"}")
HAS_ERROR=$(echo "$RESP" | json_has_key "error")
check "Duplicate connect returns error" "$HAS_ERROR" "yes"

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."
cleanup_projects project-alpha project-beta
teardown_test_dir
ok "Cleaned up"

summary
