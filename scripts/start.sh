#!/usr/bin/env bash
# Start Mica frontend and backend servers.
# Kills any stale processes on the required ports first.
set -euo pipefail

BACKEND_PORT="${MICA_PORT:-3002}"
FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"

mkdir -p "$PID_DIR"

kill_port() {
  local port=$1
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    local args
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    # Only kill mica-related processes — never VSCode's port forwarder
    # (killing that tears down the SSH session)
    if [[ "$args" == *"/workspaces/mica/"* ]] || [[ "$args" == *"vite"* ]] || [[ "$args" == *"tsx"* && "$args" == *"server/index.ts"* ]]; then
      echo "Port $port held by PID $pid ($(echo "$args" | head -c 80))"
      echo "  Killing..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    elif [ -n "$args" ]; then
      echo "Port $port also held by non-mica PID $pid ($(echo "$args" | head -c 60)) — skipping"
    fi
  done
}

kill_stale_pids() {
  for f in "$PID_DIR"/*.pid; do
    [ -f "$f" ] || continue
    local pid
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Killing stale Mica process $pid ($(basename "$f" .pid))"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  done
}

echo "=== Mica Server Startup ==="
echo ""

# Clean up anything left over
kill_stale_pids
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# Verify ports are free (excluding VSCode port forwarder, which is harmless)
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if [[ "$args" == *"/workspaces/mica/"* ]] || [[ "$args" == *"vite"* ]] || [[ "$args" == *"tsx"* && "$args" == *"server/index.ts"* ]]; then
      echo "ERROR: Port $port still held by mica PID $pid after cleanup. Aborting."
      lsof -i :"$port" 2>/dev/null
      exit 1
    fi
  done
done

cd "$PROJECT_DIR"

# Set workspace directory for the server (default: /workspaces/testproj for dev)
export PROJECT_DIR="${PROJECT_DIR_OVERRIDE:-/workspaces/testproj}"

# Start backend
echo "Starting backend on port $BACKEND_PORT..."
npm run server > "$PID_DIR/backend.log" 2>&1 &
echo $! > "$PID_DIR/backend.pid"

# Start frontend
echo "Starting frontend on port $FRONTEND_PORT..."
npm run dev > "$PID_DIR/frontend.log" 2>&1 &
echo $! > "$PID_DIR/frontend.pid"

# Wait for backend to be ready (up to 15 seconds)
echo ""
echo "Waiting for servers..."
for i in $(seq 1 15); do
  if node -e "
    const http = require('http');
    http.get('http://localhost:$BACKEND_PORT/api/projects', (r) => {
      process.exit(r.statusCode === 200 ? 0 : 1);
    }).on('error', () => process.exit(1));
  " 2>/dev/null; then
    break
  fi
  sleep 1
done

# Check results
backend_ok=false
frontend_ok=false

if kill -0 "$(cat "$PID_DIR/backend.pid" 2>/dev/null)" 2>/dev/null; then
  backend_ok=true
fi

if kill -0 "$(cat "$PID_DIR/frontend.pid" 2>/dev/null)" 2>/dev/null; then
  frontend_ok=true
fi

echo ""
if $backend_ok && $frontend_ok; then
  actual_frontend=$(grep -oP 'http://localhost:\K[0-9]+' "$PID_DIR/frontend.log" 2>/dev/null | head -1)
  actual_frontend="${actual_frontend:-$FRONTEND_PORT}"

  echo "=== Mica is running ==="
  echo "  Frontend: http://localhost:$actual_frontend/"
  echo "  Backend:  http://localhost:$BACKEND_PORT/api"
  echo ""
  echo "  Logs:     $PID_DIR/backend.log"
  echo "            $PID_DIR/frontend.log"
  echo "  Stop:     scripts/stop.sh"
else
  echo "=== Startup problem ==="
  $backend_ok  || echo "  Backend FAILED — check $PID_DIR/backend.log"
  $frontend_ok || echo "  Frontend FAILED — check $PID_DIR/frontend.log"
  echo ""
  for log in "$PID_DIR/backend.log" "$PID_DIR/frontend.log"; do
    if [ -f "$log" ]; then
      echo "--- $(basename "$log") ---"
      tail -5 "$log"
      echo ""
    fi
  done
  exit 1
fi
