#!/usr/bin/env bash
# Show Mica server status.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
BACKEND_PORT="${MICA_PORT:-3002}"

echo "=== Mica Server Status ==="
echo ""

for name in backend frontend; do
  pidfile="$PID_DIR/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "  $name: running (pid $(cat "$pidfile"))"
  else
    echo "  $name: stopped"
  fi
done

echo ""

if node -e "
  const http = require('http');
  http.get('http://localhost:$BACKEND_PORT/api/projects', (r) => {
    process.exit(r.statusCode === 200 ? 0 : 1);
  }).on('error', () => process.exit(1));
" 2>/dev/null; then
  echo "  API: responding on port $BACKEND_PORT"
else
  echo "  API: not responding on port $BACKEND_PORT"
fi

if [ -f "$PID_DIR/frontend.log" ]; then
  actual_frontend=$(grep -oP 'http://localhost:\K[0-9]+' "$PID_DIR/frontend.log" 2>/dev/null | head -1)
  if [ -n "$actual_frontend" ]; then
    echo "  Frontend: http://localhost:$actual_frontend/"
  fi
fi

# Show port status
echo ""
echo "  Ports:"
for port in "$BACKEND_PORT" 5173; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
    echo "    :$port → PID $pid ($cmd)"
  else
    echo "    :$port → free"
  fi
done
