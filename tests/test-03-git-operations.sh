#!/bin/bash
# Test 3: Per-Project Git Operations
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 03: Git Operations ==="
echo ""
setup_test_dir

PROJ_DIR="$TEST_DIR/git-test"
PROJ_ID="git-test"

# Clean slate
cleanup_projects "$PROJ_ID"

# Setup: connect a project
mkdir -p "$PROJ_DIR"
api_post "/projects/connect" "{\"path\":\"$PROJ_DIR\",\"name\":\"Git Test\"}" >/dev/null

# ── 3a: Status on fresh repo ─────────────────────────────
echo "3a. Git status..."
STATUS=$(api_get "/projects/$PROJ_ID/git/status")
HAS_CLEAN=$(echo "$STATUS" | json_has_key "clean")
check "Status has 'clean' field" "$HAS_CLEAN" "yes"
echo "  Status: $(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"clean={d.get('clean')}, untracked={len(d.get('untracked',[]))}\")")"

# ── 3b: Commit changes ───────────────────────────────────
echo ""
echo "3b. Commit..."
echo "# Git Test Project" > "$PROJ_DIR/README.md"

RESP=$(api_post "/projects/$PROJ_ID/git/commit" '{"message":"Initial commit"}')
HAS_HASH=$(echo "$RESP" | json_has_key "hash")
check "Commit returns hash" "$HAS_HASH" "yes"

COMMIT_MSG=$(echo "$RESP" | json_get "['message']")
check "Commit message matches" "$COMMIT_MSG" "Initial commit"

# Verify on disk
GIT_LOG=$(git -C "$PROJ_DIR" log --oneline -1)
check "Commit in git log" "$(echo "$GIT_LOG" | grep -c 'Initial commit')" "1"

# ── 3c: View log ─────────────────────────────────────────
echo ""
echo "3c. Git log..."
LOG=$(api_get "/projects/$PROJ_ID/git/log?limit=5")
LOG_LEN=$(echo "$LOG" | json_len)
check "Log has entries" "$([ "$LOG_LEN" -ge 1 ] && echo yes || echo no)" "yes"

# Verify log entry shape
FIRST_ENTRY=$(echo "$LOG" | python3 -c "
import sys, json
entry = json.load(sys.stdin)[0]
keys = sorted(entry.keys())
has_required = all(k in keys for k in ['hash','message'])
print('yes' if has_required else 'no')
")
check "Log entry has required fields" "$FIRST_ENTRY" "yes"

# ── 3d: View diff ────────────────────────────────────────
echo ""
echo "3d. Git diff..."
echo "A new line" >> "$PROJ_DIR/README.md"

DIFF=$(api_get "/projects/$PROJ_ID/git/diff")
HAS_CHANGE=$(echo "$DIFF" | python3 -c "
import sys, json
d = json.load(sys.stdin)
diff_text = d.get('diff','')
print('yes' if 'new line' in diff_text else 'no')
")
check "Diff shows change" "$HAS_CHANGE" "yes"

# Commit the change for subsequent tests
api_post "/projects/$PROJ_ID/git/commit" '{"message":"Add line to README"}' >/dev/null

# ── 3e: Branch operations ────────────────────────────────
echo ""
echo "3e. Branches..."
BRANCHES=$(api_get "/projects/$PROJ_ID/git/branches")
CURRENT=$(echo "$BRANCHES" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('current','unknown'))
")
check "Current branch is main or master" "$(echo "$CURRENT" | grep -cE '^(main|master)$')" "1"

# Create and checkout a new branch
RESP=$(api_post "/projects/$PROJ_ID/git/checkout" '{"branch":"feature-x","create":true}')
HAS_ERROR=$(echo "$RESP" | json_has_key "error")
check "Branch created without error" "$HAS_ERROR" "no"

# Verify switched
BRANCHES_AFTER=$(api_get "/projects/$PROJ_ID/git/branches")
CURRENT_AFTER=$(echo "$BRANCHES_AFTER" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('current','unknown'))
")
check "Switched to feature-x" "$CURRENT_AFTER" "feature-x"

# Switch back
api_post "/projects/$PROJ_ID/git/checkout" '{"branch":"main"}' >/dev/null 2>&1 || \
  api_post "/projects/$PROJ_ID/git/checkout" '{"branch":"master"}' >/dev/null 2>&1

# ── 3f: Concurrent safety ────────────────────────────────
echo ""
echo "3f. Concurrent commits..."
echo "File A" > "$PROJ_DIR/file-a.txt"
api_post "/projects/$PROJ_ID/git/commit" '{"message":"Add file A"}' >/dev/null

echo "File B" > "$PROJ_DIR/file-b.txt"
echo "File C" > "$PROJ_DIR/file-c.txt"

# Fire two commits in parallel
RESP_1_FILE=$(mktemp)
RESP_2_FILE=$(mktemp)

api_post "/projects/$PROJ_ID/git/commit" '{"message":"Concurrent commit 1"}' > "$RESP_1_FILE" &
PID1=$!
# Small delay to ensure both hit the mutex
sleep 0.1
api_post "/projects/$PROJ_ID/git/commit" '{"message":"Concurrent commit 2"}' > "$RESP_2_FILE" &
PID2=$!
wait $PID1 $PID2

# At least one should succeed; neither should show a git lock error
LOCK_ERROR_1=$(grep -c "lock" "$RESP_1_FILE" 2>/dev/null || true)
LOCK_ERROR_2=$(grep -c "lock" "$RESP_2_FILE" 2>/dev/null || true)
LOCK_ERROR_1="${LOCK_ERROR_1:-0}"
LOCK_ERROR_2="${LOCK_ERROR_2:-0}"
check "No lock errors in concurrent commits" "$([ "$LOCK_ERROR_1" -eq 0 ] 2>/dev/null && [ "$LOCK_ERROR_2" -eq 0 ] 2>/dev/null && echo yes || echo no)" "yes"

# Verify git log has commits (at least the non-concurrent ones)
LOG_COUNT=$(api_get "/projects/$PROJ_ID/git/log?limit=10" | json_len)
check "Multiple commits in log" "$([ "$LOG_COUNT" -ge 3 ] && echo yes || echo no)" "yes"
echo "  Total commits: $LOG_COUNT"

rm -f "$RESP_1_FILE" "$RESP_2_FILE"

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."
cleanup_projects "$PROJ_ID"
teardown_test_dir
ok "Cleaned up"

summary
