#!/usr/bin/env bash
# Stop the Nemotron 3 Nano Omni container started by start-omni.sh.
# docker stop + docker rm; cleans up the cid file. Leaves omni.log in
# place for postmortem.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
CID_FILE="$PID_DIR/omni.cid"

CONTAINER_NAME="${OMNI_CONTAINER_NAME:-mica-omni}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH."
  exit 1
fi

stopped=0

# Stop by name (the durable identifier — cid file is a convenience).
state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [ "$state" = "running" ]; then
  echo "Stopping omni container ($CONTAINER_NAME)..."
  docker stop --time 30 "$CONTAINER_NAME" >/dev/null
  stopped=$((stopped + 1))
fi
if [ -n "$state" ]; then
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

# Also kill any background `docker logs -f` tails from start-omni.sh.
# pkill is best-effort; fine if nothing matches.
pkill -f "docker logs -f $CONTAINER_NAME" 2>/dev/null || true

rm -f "$CID_FILE"

if [ "$stopped" -eq 0 ]; then
  echo "No omni container was running."
fi
