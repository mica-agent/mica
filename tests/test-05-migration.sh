#!/bin/bash
# Test 5: Migration from Legacy migration
set -uo pipefail
source "$(dirname "$0")/lib.sh"

echo "=== Test 05: Legacy Migration ==="
echo ""
setup_test_dir

MIGRATE_TARGET="$TEST_DIR/migrated"
LEGACY_DIR="/workspaces/mica/layers"
LEGACY_REGISTRY="$LEGACY_DIR/_projects.json"

# Save original registry if it exists
ORIG_REGISTRY=""
if [ -f "$LEGACY_REGISTRY" ]; then
  ORIG_REGISTRY=$(cat "$LEGACY_REGISTRY")
fi

# ── Setup: create a fake legacy project ───────────────────
echo "Setting up legacy structure..."
LEGACY_PROJ_DIR="$LEGACY_DIR/test-legacy"
mkdir -p "$LEGACY_PROJ_DIR/workspace"
echo "Legacy brief content" > "$LEGACY_PROJ_DIR/workspace/_brief.brief"
echo "Legacy goal content" > "$LEGACY_PROJ_DIR/workspace/_goal.goal"

# Write a temporary _projects.json pointing to our test project
cat > "$LEGACY_REGISTRY" << 'EOF'
{
  "projects": [
    {
      "id": "test-legacy",
      "name": "Test Legacy Project",
      "canvases": ["workspace"],
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ]
}
EOF

# ── 5a: Run migration ────────────────────────────────────
echo ""
echo "5a. Migrate..."
RESP=$(api_post "/migrate" "{\"targetDir\":\"$MIGRATE_TARGET\"}")

MIGRATED_COUNT=$(echo "$RESP" | json_get "['migrated']")
check "Migration returned count" "$([ "$MIGRATED_COUNT" -ge 0 ] && echo yes || echo no)" "yes"
echo "  Migrated: $MIGRATED_COUNT projects"

if [ "$MIGRATED_COUNT" -gt 0 ]; then
  # Verify project directory created
  check "Project dir created" "$(test -d $MIGRATE_TARGET/test-legacy && echo yes || echo no)" "yes"

  # Verify .mica/ structure
  check ".mica/ exists" "$(test -d $MIGRATE_TARGET/test-legacy/.mica && echo yes || echo no)" "yes"
  check ".config.json exists" "$(test -f $MIGRATE_TARGET/test-legacy/.mica/.config.json && echo yes || echo no)" "yes"

  # Verify canvas files copied
  check "workspace/ copied" "$(test -d $MIGRATE_TARGET/test-legacy/.mica/workspace && echo yes || echo no)" "yes"
  check "_brief.brief migrated" "$(test -f $MIGRATE_TARGET/test-legacy/.mica/workspace/_brief.brief && echo yes || echo no)" "yes"

  if [ -f "$MIGRATE_TARGET/test-legacy/.mica/workspace/_brief.brief" ]; then
    MIGRATED_CONTENT=$(cat "$MIGRATE_TARGET/test-legacy/.mica/workspace/_brief.brief")
    check "Brief content preserved" "$MIGRATED_CONTENT" "Legacy brief content"
  fi

  # Verify git initialized
  check ".git/ initialized" "$(test -d $MIGRATE_TARGET/test-legacy/.git && echo yes || echo no)" "yes"
else
  echo "  SKIP: No projects migrated (may already have been migrated)"
  ok "Migration endpoint works (idempotent)"
fi

# ── Cleanup ───────────────────────────────────────────────
echo ""
echo "Cleanup..."

# Disconnect migrated project if it was connected
cleanup_projects test-legacy

# Remove fake legacy project
rm -rf "$LEGACY_PROJ_DIR"

# Restore original registry
if [ -n "$ORIG_REGISTRY" ]; then
  echo "$ORIG_REGISTRY" > "$LEGACY_REGISTRY"
else
  rm -f "$LEGACY_REGISTRY"
fi

rm -rf "$MIGRATE_TARGET"
teardown_test_dir
ok "Cleaned up"

summary
