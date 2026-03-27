#!/bin/bash
# Hello World integration test — create projects, verify isolation, check cards
set -uo pipefail

API="http://localhost:3001/api"
PASS=0
FAIL=0

ok()   { echo "  PASS: $1"; ((PASS++)); }
fail() { echo "  FAIL: $1"; ((FAIL++)); }
check() {
  # usage: check "description" <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got '$2', expected '$3')"; fi
}

echo "=== Mica Hello World Test ==="
echo ""

# ── Clean slate: disconnect any test projects from prior runs ──
for proj in hello-alpha hello-beta; do
  curl -s -X POST "$API/projects/$proj/disconnect" >/dev/null 2>&1 || true
done

# ── 1. Create two projects ──────────────────────────────────
echo "1. Creating projects..."

ALPHA=$(curl -s -X POST "$API/projects" \
  -H "Content-Type: application/json" \
  -d '{"id":"hello-alpha","name":"Hello Alpha"}')
ALPHA_ID=$(echo "$ALPHA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "ERROR")
check "Create hello-alpha" "$ALPHA_ID" "hello-alpha"

BETA=$(curl -s -X POST "$API/projects" \
  -H "Content-Type: application/json" \
  -d '{"id":"hello-beta","name":"Hello Beta"}')
BETA_ID=$(echo "$BETA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "ERROR")
check "Create hello-beta" "$BETA_ID" "hello-beta"

# ── 2. Verify both appear in project list ────────────────────
echo ""
echo "2. Listing projects..."

PROJ_COUNT=$(curl -s "$API/projects" | python3 -c "
import sys, json
projects = json.load(sys.stdin)
ids = [p['id'] for p in projects]
# Count how many of our test projects exist
count = sum(1 for p in ['hello-alpha','hello-beta'] if p in ids)
print(count)
")
check "Both projects in list" "$PROJ_COUNT" "2"

# ── 3. Verify .mica/ structure was created ───────────────────
echo ""
echo "3. Checking .mica/ structure..."

for proj in hello-alpha hello-beta; do
  BASE=~/mica-projects/$proj
  check "$proj: .mica/ exists" "$(test -d $BASE/.mica && echo yes || echo no)" "yes"
  check "$proj: config.json exists" "$(test -f $BASE/.mica/config.json && echo yes || echo no)" "yes"
  check "$proj: workspace/ dir exists" "$(test -d $BASE/.mica/workspace && echo yes || echo no)" "yes"
  check "$proj: _brief.md seeded" "$(test -f $BASE/.mica/workspace/_brief.md && echo yes || echo no)" "yes"
  check "$proj: _goal.md seeded" "$(test -f $BASE/.mica/workspace/_goal.md && echo yes || echo no)" "yes"
  check "$proj: _todo.md seeded" "$(test -f $BASE/.mica/workspace/_todo.md && echo yes || echo no)" "yes"
  check "$proj: git initialized" "$(test -d $BASE/.git && echo yes || echo no)" "yes"
done

# ── 4. Verify config.json contents ──────────────────────────
echo ""
echo "4. Checking config.json..."

ALPHA_NAME=$(python3 -c "import json; print(json.load(open('$HOME/mica-projects/hello-alpha/.mica/config.json'))['name'])")
check "Alpha config name" "$ALPHA_NAME" "Hello Alpha"

BETA_NAME=$(python3 -c "import json; print(json.load(open('$HOME/mica-projects/hello-beta/.mica/config.json'))['name'])")
check "Beta config name" "$BETA_NAME" "Hello Beta"

# ── 5. Verify layer files via API ────────────────────────────
echo ""
echo "5. Reading layer files via API..."

ALPHA_FILES=$(curl -s "$API/projects/hello-alpha/layers/workspace/files" | python3 -c "
import sys, json
files = json.load(sys.stdin)
print(','.join(sorted(f['name'] for f in files)))
")
echo "  Alpha files: $ALPHA_FILES"
# Should have at least _brief.md, _goal.md, _todo.md, _log.md
check "Alpha has _brief.md" "$(echo $ALPHA_FILES | grep -c _brief.md)" "1"
check "Alpha has _goal.md" "$(echo $ALPHA_FILES | grep -c _goal.md)" "1"

# ── 6. Write a unique file to each project (isolation test) ──
echo ""
echo "6. Writing project-specific files (isolation test)..."

curl -s -X PUT "$API/projects/hello-alpha/layers/workspace/files/hello.md" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Hello from Alpha\n\nThis is project Alpha."}' >/dev/null
ok "Wrote hello.md to Alpha"

curl -s -X PUT "$API/projects/hello-beta/layers/workspace/files/hello.md" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Hello from Beta\n\nThis is project Beta."}' >/dev/null
ok "Wrote hello.md to Beta"

# Read back and verify isolation
ALPHA_HELLO=$(curl -s "$API/projects/hello-alpha/layers/workspace/files/hello.md" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")
BETA_HELLO=$(curl -s "$API/projects/hello-beta/layers/workspace/files/hello.md" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")

check "Alpha hello.md has Alpha content" "$(echo "$ALPHA_HELLO" | grep -q 'Alpha' && echo yes || echo no)" "yes"
check "Beta hello.md has Beta content" "$(echo "$BETA_HELLO" | grep -q 'Beta' && echo yes || echo no)" "yes"
check "Alpha hello.md does NOT have Beta content" "$(echo "$ALPHA_HELLO" | grep -c 'Beta')" "0"
check "Beta hello.md does NOT have Alpha content" "$(echo "$BETA_HELLO" | grep -c 'Alpha')" "0"

# ── 7. Render cards (verify card class runtime works) ────────
echo ""
echo "7. Rendering cards..."

ALPHA_CARDS=$(curl -s "$API/projects/hello-alpha/layers/workspace/cards")
ALPHA_CARD_COUNT=$(echo "$ALPHA_CARDS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  Alpha rendered $ALPHA_CARD_COUNT cards"
check "Alpha has rendered cards" "$([ "$ALPHA_CARD_COUNT" -gt 0 ] && echo yes || echo no)" "yes"

# Check that hello.md rendered as HTML
HELLO_HTML=$(echo "$ALPHA_CARDS" | python3 -c "
import sys, json
cards = json.load(sys.stdin)
for c in cards:
    if c['filename'] == 'hello.md':
        print('has_html' if '<' in c.get('html','') else 'no_html')
        break
else:
    print('not_found')
")
check "hello.md rendered to HTML" "$HELLO_HTML" "has_html"

# ── 8. Container test (Docker availability) ─────────────────
echo ""
echo "8. Container test..."

if command -v docker &>/dev/null; then
  echo "  Docker available — testing container isolation..."

  # Start containers for both projects
  ALPHA_CONTAINER=$(curl -s -X POST "$API/projects/hello-alpha/container/start")
  ALPHA_STATUS=$(echo "$ALPHA_CONTAINER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
  check "Alpha container started" "$ALPHA_STATUS" "running"

  BETA_CONTAINER=$(curl -s -X POST "$API/projects/hello-beta/container/start")
  BETA_STATUS=$(echo "$BETA_CONTAINER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
  check "Beta container started" "$BETA_STATUS" "running"

  # Verify different container names
  ALPHA_CNAME=$(echo "$ALPHA_CONTAINER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('containerName',''))" 2>/dev/null)
  BETA_CNAME=$(echo "$BETA_CONTAINER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('containerName',''))" 2>/dev/null)
  check "Different container names" "$([ "$ALPHA_CNAME" != "$BETA_CNAME" ] && echo yes || echo no)" "yes"

  # Verify different port allocations
  ALPHA_PORT=$(echo "$ALPHA_CONTAINER" | python3 -c "import sys,json; ports=json.load(sys.stdin).get('ports',[]); print(ports[0]['host'] if ports else 'none')" 2>/dev/null)
  BETA_PORT=$(echo "$BETA_CONTAINER" | python3 -c "import sys,json; ports=json.load(sys.stdin).get('ports',[]); print(ports[0]['host'] if ports else 'none')" 2>/dev/null)
  if [ "$ALPHA_PORT" != "none" ] && [ "$BETA_PORT" != "none" ]; then
    check "Different port allocations" "$([ "$ALPHA_PORT" != "$BETA_PORT" ] && echo yes || echo no)" "yes"
  fi

  # Clean up containers
  curl -s -X POST "$API/projects/hello-alpha/container/stop" >/dev/null 2>&1
  curl -s -X POST "$API/projects/hello-beta/container/stop" >/dev/null 2>&1
  ok "Containers stopped"
else
  echo "  SKIP: Docker not available in this environment."
  echo "  Container isolation tests require docker-in-docker devcontainer feature."
fi

# ── 9. Cleanup ───────────────────────────────────────────────
echo ""
echo "9. Cleanup..."

curl -s -X POST "$API/projects/hello-alpha/disconnect" >/dev/null
curl -s -X POST "$API/projects/hello-beta/disconnect" >/dev/null
ok "Disconnected test projects"

# Verify they're gone from registry
REMAINING=$(curl -s "$API/projects" | python3 -c "
import sys, json
ids = [p['id'] for p in json.load(sys.stdin)]
print(sum(1 for p in ['hello-alpha','hello-beta'] if p in ids))
")
check "Test projects removed from registry" "$REMAINING" "0"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "==============================="
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
echo "==============================="

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
