#!/usr/bin/env bash
# Stop Mica frontend and backend servers.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
BACKEND_PORT="${MICA_PORT:-3002}"
FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"

stopped=0

# Stop tracked processes via PID files
for name in backend frontend; do
  pidfile="$PID_DIR/$name.pid"
  [ -f "$pidfile" ] || continue

  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 5); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "  Force killing $name..."
      kill -9 "$pid" 2>/dev/null || true
    fi
    stopped=$((stopped + 1))
  else
    echo "$name not running (stale pid file)"
  fi
  rm -f "$pidfile"
done

# Kill orphaned mica processes still holding the ports
# IMPORTANT: filter to node/tsx processes only — never kill VSCode's port forwarder
# (which would tear down the remote SSH session)
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    cmdline=$(ps -p "$pid" -o args= 2>/dev/null || true)
    # Only kill if it's a node/tsx process running mica
    if [[ "$cmd" == "node" || "$cmd" == "tsx" ]] && [[ "$cmdline" == *"mica"* || "$cmdline" == *"vite"* || "$cmdline" == *"tsx"* ]]; then
      echo "Killing orphaned mica process on port $port (pid $pid, $cmd)"
      kill "$pid" 2>/dev/null || true
      stopped=$((stopped + 1))
    elif [ -n "$cmd" ]; then
      echo "Skipping non-mica process on port $port (pid $pid, $cmd) — likely VSCode port forwarder"
    fi
  done
done

if [ "$stopped" -eq 0 ]; then
  echo "No Mica servers were running."
else
  echo "Stopped $stopped process(es)."
fi


rm -f "$PID_DIR"/*.log "$PID_DIR"/*.pid 2>/dev/null || true
