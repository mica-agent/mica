#!/bin/bash
# Test 2: Layer Metadata Operations
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 02: Layer Metadata ==="
echo ""
setup_test_dir

PROJ_DIR="$TEST_DIR/meta-test"
PROJ_ID="meta-test"

# Clean slate
cleanup_projects "$PROJ_ID"

# Setup: connect a project
mkdir -p "$PROJ_DIR"
api_post "/projects/connect" "{\"path\":\"$PROJ_DIR\",\"name\":\"Meta Test\"}" >/dev/null

# ── 2a: List files ────────────────────────────────────────
echo "2a. List workspace files..."
FILES=$(api_get "/projects/$PROJ_ID/layers/workspace/files")
FILE_COUNT=$(echo "$FILES" | json_len)
check "Files endpoint returns array" "$([ "$FILE_COUNT" -ge 0 ] && echo yes || echo no)" "yes"
echo "  Found $FILE_COUNT files"

# ── 2b: Write and read a brief ────────────────────────────
echo ""
echo "2b. Write and read _brief.md..."
api_put "/projects/$PROJ_ID/layers/workspace/files/_brief.md" \
  '{"content":"You are a test agent. Be concise."}' >/dev/null

# Read back via API
CONTENT=$(api_get "/projects/$PROJ_ID/layers/workspace/files/_brief.md" | json_get "['content']")
check "Read back matches" "$CONTENT" "You are a test agent. Be concise."

# Verify on disk
DISK_CONTENT=$(cat "$PROJ_DIR/.mica/workspace/_brief.md")
check "File exists on disk" "$DISK_CONTENT" "You are a test agent. Be concise."

# Write another file
api_put "/projects/$PROJ_ID/layers/workspace/files/notes.md" \
  '{"content":"# Notes\n\nSome notes here."}' >/dev/null

# Verify file count increased
FILES_AFTER=$(api_get "/projects/$PROJ_ID/layers/workspace/files" | json_len)
check "File count increased" "$([ "$FILES_AFTER" -gt "$FILE_COUNT" ] && echo yes || echo no)" "yes"

# Delete a file
api_delete "/projects/$PROJ_ID/layers/workspace/files/notes.md" >/dev/null
FILES_DELETED=$(api_get "/projects/$PROJ_ID/layers/workspace/files" | json_len)
check "File deleted" "$([ "$FILES_DELETED" -lt "$FILES_AFTER" ] && echo yes || echo no)" "yes"

# ── 2c: Add a layer ──────────────────────────────────────
echo ""
echo "2c. Add a layer..."
RESP=$(api_post "/projects/$PROJ_ID/layers" '{"name":"architecture"}')
SUCCESS=$(echo "$RESP" | json_get "['success']")
check "Add layer returns success" "$SUCCESS" "True"

# Verify directory created
check "Layer dir created" "$(test -d $PROJ_DIR/.mica/architecture && echo yes || echo no)" "yes"

# Verify config updated
HAS_LAYER=$(python3 -c "
import json
config = json.load(open('$PROJ_DIR/.mica/config.json'))
print('yes' if 'architecture' in config.get('layers',[]) else 'no')
")
check "Config includes new layer" "$HAS_LAYER" "yes"

# Verify duplicate layer rejected
RESP=$(api_post "/projects/$PROJ_ID/layers" '{"name":"architecture"}')
HAS_ERROR=$(echo "$RESP" | json_has_key "error")
check "Duplicate layer rejected" "$HAS_ERROR" "yes"

# Can write files to new layer
api_put "/projects/$PROJ_ID/layers/architecture/files/_brief.md" \
  '{"content":"Architecture agent brief."}' >/dev/null
ARCH_CONTENT=$(api_get "/projects/$PROJ_ID/layers/architecture/files/_brief.md" | json_get "['content']")
check "Can write to new layer" "$ARCH_CONTENT" "Architecture agent brief."

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."
cleanup_projects "$PROJ_ID"
teardown_test_dir
ok "Cleaned up"

summary
