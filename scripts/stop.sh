#!/usr/bin/env bash
# Stop Mica processes. By default LEAVES the chat vLLM container running
# so a subsequent start.sh / restart.sh comes back fast (vLLM cold-boot
# is 30-90s warm, several minutes cold; backend + frontend are seconds).
#
# Use --full / -f to also stop the chat container (e.g. for a clean
# host reboot, or to free GPU memory for an out-of-band workload).
#
# Always stops:
#   - backend, frontend (Node processes by PID file + port sweep)
#   - voice sidecars (Parakeet, Kokoro) — the orphan-sidecar problem
#     was the source of every "still using GPU memory" debug session
#   - any leftover llama-server (defensive, rollback path)
#
# Stopped only with --full:
#   - chat vLLM container (mica-chat)
#
# Usage: scripts/stop.sh [--full | -f]

set -euo pipefail

FULL_TEARDOWN=0
for arg in "$@"; do
  case "$arg" in
    --full|-f) FULL_TEARDOWN=1 ;;
    --help|-h)
      sed -n '1,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--full | -f]" >&2
      exit 1
      ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
BACKEND_PORT="${MICA_PORT:-3002}"
FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"
CHAT_NAME="${CHAT_VLLM_NAME:-mica-chat}"

# shellcheck source=lib/vllm-container.sh
. "$PROJECT_DIR/scripts/lib/vllm-container.sh"

stopped=0

# ── Backend / frontend (PID file + port sweep) ──────────────────
for name in backend frontend; do
  pidfile="$PID_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 5); do
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

# Orphan node/tsx still squatting on the ports — kill defensively, but
# never kill VSCode's port forwarder (would tear down the SSH session).
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    cmdline=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if [[ "$cmd" == "node" || "$cmd" == "tsx" ]] && [[ "$cmdline" == *"mica"* || "$cmdline" == *"vite"* || "$cmdline" == *"tsx"* ]]; then
      echo "Killing orphan mica process on port $port (pid $pid, $cmd)"
      kill "$pid" 2>/dev/null || true
      stopped=$((stopped + 1))
    elif [ -n "$cmd" ]; then
      echo "Skipping non-mica process on port $port (pid $pid, $cmd) — likely VSCode port forwarder"
    fi
  done
done

# ── Voice sidecars (Parakeet STT, Kokoro TTS) ───────────────────
# These are spawned by server/voiceServers.ts as children of the
# backend. When the backend dies, they re-parent to PID 1 instead of
# exiting and continue holding GPU memory until killed explicitly.
# Match by command name (the venv-python paths are unambiguous).
# `|| true` keeps the empty-result case from tripping `set -e` / pipefail:
# `grep` returns 1 when no sidecars are running, which would otherwise exit
# the script before the container-teardown block below.
sidecar_pids=$(ps aux | grep -E "voice-(stt|tts)-server\.py" | grep -v grep | awk '{print $2}' || true)
if [ -n "$sidecar_pids" ]; then
  echo "Killing voice sidecars (Parakeet/Kokoro): $(echo $sidecar_pids | tr '\n' ' ')"
  for pid in $sidecar_pids; do
    kill "$pid" 2>/dev/null || true
    stopped=$((stopped + 1))
  done
  sleep 2
  # Force-kill survivors
  for pid in $sidecar_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
fi

# ── Leftover llama-server (rollback path / pre-vLLM-migration) ──
# Defensive: if you fall back to llama-server while iterating, this
# catches it on stop.sh too. Safe no-op once nobody runs llama-server.
llama_pids=$(ps aux | grep -E "llama-server" | grep -v grep | awk '{print $2}' || true)
if [ -n "$llama_pids" ]; then
  echo "Killing llama-server processes: $(echo $llama_pids | tr '\n' ' ')"
  for pid in $llama_pids; do
    kill "$pid" 2>/dev/null || true
    stopped=$((stopped + 1))
  done
fi

# ── Chat vLLM container (only with --full) ─────────────────────
# Default: leave it warm. start.sh's idempotency check reuses it on
# next start, skipping the 30-90s vLLM boot. With --full we tear it
# down too, e.g. for a clean host reboot.
if [ "$FULL_TEARDOWN" -eq 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    if vllm_container_running "$CHAT_NAME"; then
      echo "Stopping chat vLLM container ($CHAT_NAME)... [--full]"
      vllm_container_stop "$CHAT_NAME"
      rm -f "$PID_DIR/chat.cid"
      stopped=$((stopped + 1))
    fi
  fi
elif command -v docker >/dev/null 2>&1 && vllm_container_running "$CHAT_NAME"; then
  echo "Chat vLLM container ($CHAT_NAME) left running (use --full to stop)."
fi

if [ "$stopped" -eq 0 ]; then
  if [ "$FULL_TEARDOWN" -eq 1 ]; then
    echo "No Mica processes were running."
  else
    echo "No Mica processes were running. (Chat vLLM container may still be up — use --full to stop it too.)"
  fi
else
  echo "Stopped $stopped process(es)."
fi

# Note: we leave .mica-pids/*.log alone for postmortem. PID/CID files
# get cleaned up above as we kill each process.
