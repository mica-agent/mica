#!/usr/bin/env bash
# Start Mica frontend and backend servers.
# Kills any stale processes on the required ports first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Save the inherited PROJECT_DIR from the caller's env (if any) BEFORE
# anything in this script reassigns the local variable below. The
# inherited value is the WORKSPACE root the backend will scope to —
# different concern from the local PROJECT_DIR on line ~32, which is
# repurposed as the repo-root location for cd / PID files. Without
# preserving this, containers that set ENV PROJECT_DIR=/project (the
# release Dockerfile + docker-compose) would have it stomped by the
# /workspaces/testproj dev fallback at line ~94.
_INHERITED_PROJECT_DIR="${PROJECT_DIR:-}"

# Source .env so MICA_PORT / MICA_FRONTEND_PORT / etc. set there reach this
# shell. Mirrors server/index.ts + vite.config.ts resolution: workspace .env
# first, repo-root .env as fallback. Ambient env that was already set in the
# invoking shell wins over both (we only assign to unset vars via default
# expansion below). The `set -a / set +a` dance auto-exports every var the
# file defines so they propagate to the backend + vite children.
_src_env() {
  local f="$1"
  [ -f "$f" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}
# Workspace .env lives at PROJECT_DIR_OVERRIDE (caller-set) OR the dev
# default used below at line ~87 (/workspaces/testproj) OR the Docker
# default (/project). Try each in order.
for _candidate in "${PROJECT_DIR_OVERRIDE:-}" /workspaces/testproj /project; do
  [ -n "$_candidate" ] && _src_env "$_candidate/.env" && break || true
done
_src_env "$REPO_ROOT/.env"

BACKEND_PORT="${MICA_PORT:-3002}"
FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"
PROJECT_DIR="$REPO_ROOT"
PID_DIR="$PROJECT_DIR/.mica-pids"

mkdir -p "$PID_DIR"

kill_port() {
  local port=$1
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    local args
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    # Only kill mica-related processes — never VSCode's port forwarder
    # (killing that tears down the SSH session). REPO_ROOT matches the
    # repo path regardless of where it's checked out (/workspaces/mica
    # in the devcontainer; /opt/mica in the release image; etc.).
    if [[ "$args" == *"$REPO_ROOT/"* ]] || [[ "$args" == *"vite"* ]] || [[ "$args" == *"tsx"* && "$args" == *"server/index.ts"* ]]; then
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
    if [[ "$args" == *"$REPO_ROOT/"* ]] || [[ "$args" == *"vite"* ]] || [[ "$args" == *"tsx"* && "$args" == *"server/index.ts"* ]]; then
      echo "ERROR: Port $port still held by mica PID $pid after cleanup. Aborting."
      lsof -i :"$port" 2>/dev/null
      exit 1
    fi
  done
done

cd "$PROJECT_DIR"

# Set workspace directory for the server. Priority:
#   1. PROJECT_DIR_OVERRIDE (explicit caller override)
#   2. Inherited PROJECT_DIR from env (release Dockerfile / compose
#      set ENV PROJECT_DIR=/project; this honors that)
#   3. Dev default /workspaces/testproj (only fires outside containers)
export PROJECT_DIR="${PROJECT_DIR_OVERRIDE:-${_INHERITED_PROJECT_DIR:-/workspaces/testproj}}"

# ── Chat vLLM container (deferred until voice is healthy) ───────
# Voice-first boot order: backend + voice sidecars start FIRST so Parakeet
# and Kokoro can claim their ~3.4 GB of GPU memory against an empty pool.
# THEN we start the chat vLLM container so its `--gpu-memory-utilization
# 0.55` computes against (total - voice's slice). This eliminates the
# boot-time race that caused Kokoro to OOM during vLLM's allocator-grow
# window. Mirrors docker-compose.yml's healthcheck-gated dependency.
#
# We set up the chat vLLM variables here (so backend startup gets the
# right LLAMA_URL + MICA_DISABLE_LLAMA env) but defer the actual
# `docker run` to the post-backend-healthy block further down.
#
# Set MICA_DISABLE_CHAT_VLLM=1 to skip entirely (e.g. frontend-only
# iteration, or you've started an external vLLM yourself).
CHAT_VLLM_ENABLED=0
if [ "${MICA_DISABLE_CHAT_VLLM:-0}" != "1" ]; then
  CHAT_VLLM_ENABLED=1
  # PROJECT_DIR gets overwritten to the workspace path lower in this
  # script (it's the env the backend reads to scope its workspace).
  # Use REPO_ROOT here, which always points at the Mica repo.
  # shellcheck source=lib/vllm-container.sh
  . "$REPO_ROOT/scripts/lib/vllm-container.sh"

  CHAT_NAME="${CHAT_VLLM_NAME:-mica-chat}"
  CHAT_IMAGE="${CHAT_VLLM_IMAGE:-vllm/vllm-openai:cu130-nightly}"
  CHAT_MODEL="${CHAT_VLLM_MODEL:-RedHatAI/Qwen3.6-35B-A3B-NVFP4}"
  CHAT_PORT="${CHAT_VLLM_PORT:-8012}"
  # CHAT_HOST: from inside the devcontainer, host-published ports are
  # at the docker bridge gateway (172.17.0.1), not localhost. From the
  # host shell, localhost works. Override with CHAT_VLLM_HOST if your
  # bridge IP differs. Set unconditionally so both the already-running
  # and the fresh-start paths can reference it.
  CHAT_HOST="${CHAT_VLLM_HOST:-172.17.0.1}"
  HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"
  CHAT_HEALTH_TIMEOUT="${CHAT_VLLM_HEALTH_TIMEOUT:-1500}"
  # Spec-decoding config passed to `vllm serve --speculative-config`.
  # Default keeps the historical MTP-1 setting verbatim. Override with
  # CHAT_VLLM_SPEC_CONFIG to A/B different MTP settings — e.g.
  #   CHAT_VLLM_SPEC_CONFIG='{"method":"qwen3_next_mtp","num_speculative_tokens":3}'
  # Use a plain if/else rather than `${VAR:-{...}}` parameter expansion:
  # bash's parameter expansion eats one of the closing `}`s when the
  # default value itself contains balanced braces, which corrupts overrides.
  if [ -n "${CHAT_VLLM_SPEC_CONFIG:-}" ]; then
    CHAT_SPEC_CONFIG="$CHAT_VLLM_SPEC_CONFIG"
  else
    CHAT_SPEC_CONFIG='{"method":"mtp","num_speculative_tokens":1}'
  fi

  # Build the vLLM command up-front so the post-backend-healthy block
  # can launch it without re-deriving config. Steve Scargall's April 2026
  # Spark recipe for Qwen3.6-NVFP4. MTP-1 spec decode + flashinfer_cutlass
  # MoE backend.
  #
  # Served-model-name convention:
  #   - `qwen-vl`   — semantic alias for direct vLLM callers
  #                   (renderCapture, micaAgent's captioning fetch). Today
  #                   this resolves to the same Qwen3.6 multimodal vLLM
  #                   as everything else; when a dedicated VL model lands,
  #                   only this alias re-points.
  #   - `qwen-voice` — semantic alias for voiceAgent. Same container today;
  #                   re-points if we move voice to Qwen-Omni or similar.
  #   - `qwen3-vl-local` — SDK-bound alias. The qwen-code SDK gates image
  #                   modality off the model name via `/^qwen3-vl-/` regex
  #                   (see server/micaAgent.ts ~line 1620). Required for
  #                   SDK callers (the chat agent loop, plugins/llmAgent.ts);
  #                   they CANNOT use `qwen-vl` without losing image-bearing
  #                   tool results. Keep this alias until the SDK constraint
  #                   is removed upstream.
  #   - `openai:qwen-vl` — opencode bridge's OpenAI-API-compatible alias.
  #   - `openai:qwen3-vl-local` — SDK-bound path's OpenAI-prefixed form.
  #                   micaAgent.ts and plugins/llmAgent.ts build
  #                   `openai:${modelName}` strings for SDK calls, so both
  #                   the bare and `openai:`-prefixed SDK-bound names need
  #                   to be served.
  # Convention rules: no version numbers, no quantization, no hosting in
  # served names — those belong in $CHAT_MODEL only. Roles map to aliases
  # one-to-one (today + future-pointing). See ARCHITECTURE.md decisions.
  CHAT_CMD=$(cat <<EOF
vllm serve $CHAT_MODEL \
  --host 0.0.0.0 --port 8000 \
  --served-model-name qwen-vl qwen-voice openai:qwen-vl qwen3-vl-local openai:qwen3-vl-local \
  --quantization compressed-tensors \
  --moe-backend flashinfer_cutlass \
  --kv-cache-dtype fp8_e4m3 \
  --speculative-config '$CHAT_SPEC_CONFIG' \
  --gpu-memory-utilization 0.55 \
  --max-model-len 131072 \
  --max-num-batched-tokens 8192 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --trust-remote-code \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen3_coder \
  --enable-auto-tool-choice \
  --default-chat-template-kwargs '{"enable_thinking": true, "preserve_thinking": true}' \
  --limit-mm-per-prompt '{"image":4,"video":1}' \
  --override-generation-config '{"temperature":0.6,"top_p":0.95,"top_k":20,"max_new_tokens":8192}'
EOF
)

  # If chat vLLM is already running from a previous session, we don't
  # need the voice-first delay — vLLM's pool is already established, so
  # voice will load against a stable allocator regardless of order. Just
  # report and proceed; the post-backend block will skip the start path.
  if vllm_container_running "$CHAT_NAME"; then
    echo "Chat vLLM ($CHAT_NAME) already running on :$CHAT_PORT"
  fi
  # The backend's startup auto-spawns llama-server unless this is set.
  # Chat vLLM is up (or about to be) on the same port — we don't want
  # both fighting. Set BEFORE backend launch so the backend's
  # ensureLlamaServer gate sees it.
  export MICA_DISABLE_LLAMA=1
  # Backend processes (chat/voice/render) reach the chat vLLM via the
  # host docker bridge, not localhost. Export so server/{micaChat,
  # micaAgent,voiceAgent,index}.ts all share one source of truth.
  export LLAMA_URL="${LLAMA_URL:-http://$CHAT_HOST:$CHAT_PORT}"
fi
# ── End chat vLLM container setup ───────────────────────────────

# Start backend. We invoke tsx, which itself spawns a node child running our
# code. We record the *child* PID so that external kills (e.g. `kill -TERM`)
# target the actual server process — its signal traps fire and the log captures
# which signal arrived. If we recorded the wrapper, SIGHUP would kill the child
# silently without any log evidence of the cause.
record_child_pid() {
  local wrapper_pid=$1
  local pid_file=$2
  local child=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    # Suppress pgrep's non-zero exit (no match) so `set -e + pipefail` doesn't abort.
    child=$(pgrep -P "$wrapper_pid" 2>/dev/null || true)
    child=$(echo "$child" | head -1)
    if [ -n "$child" ]; then
      echo "$child" > "$pid_file"
      return 0
    fi
    sleep 0.2
  done
  # Fall back to wrapper if the child never appeared.
  echo "$wrapper_pid" > "$pid_file"
}

echo "Starting backend on port $BACKEND_PORT..."
# LSP integration removed 2026-05-01 — see comment block in
# server/micaAgent.ts (search "LSP integration removed") for the
# rationale and the conditions under which to revive. Reviving means
# restoring scripts/qwen-lsp-wrapper.mjs from git, the
# pathToQwenExecutable line in micaAgent.ts, AND re-exporting
# QWEN_CODE_CLI_PATH here.
# setsid + nohup so the server survives SIGHUP when the launching shell (which
# may be short-lived — e.g. a non-interactive `bash scripts/restart.sh` from
# an automation tool) exits. Without this, plain `&` backgrounded processes
# receive SIGHUP on parent exit and shut down cleanly, which looks like a
# random "server crash" after restart.
setsid nohup node "$REPO_ROOT/node_modules/.bin/tsx" server/index.ts > "$PID_DIR/backend.log" 2>&1 < /dev/null &
record_child_pid $! "$PID_DIR/backend.pid"

echo "Starting frontend on port $FRONTEND_PORT..."
setsid nohup node "$REPO_ROOT/node_modules/.bin/vite" > "$PID_DIR/frontend.log" 2>&1 < /dev/null &
record_child_pid $! "$PID_DIR/frontend.pid"

# Wait for backend's HTTP listener to come up (up to 15 seconds).
# This is a liveness probe, not voice readiness — that comes next.
echo ""
echo "Waiting for backend..."
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

# Voice-first boot order: wait for backend /health to report voice ready
# (or terminally failed) BEFORE starting the chat vLLM container. Voice
# sidecars then claim their ~3.4 GB of GPU memory against an empty pool,
# and vLLM's --gpu-memory-utilization 0.55 reservation lands cleanly
# against (total - voice). Eliminates the boot-time race that previously
# caused Kokoro OOM during vLLM's allocator-grow window.
#
# Skipped when:
#   - MICA_DISABLE_CHAT_VLLM=1 (no vLLM to coexist with)
#   - MICA_DISABLE_VOICE=1     (no voice sidecars to wait for)
#   - chat vLLM is already running (its pool is already established;
#     voice will load fine against a stable allocator regardless)
HEALTH_WAIT_REASON=""
if [ "${MICA_DISABLE_CHAT_VLLM:-0}" = "1" ]; then
  HEALTH_WAIT_REASON="chat-vllm disabled"
elif [ "${MICA_DISABLE_VOICE:-0}" = "1" ]; then
  HEALTH_WAIT_REASON="voice disabled"
elif [ "$CHAT_VLLM_ENABLED" = "1" ] && vllm_container_running "$CHAT_NAME"; then
  HEALTH_WAIT_REASON="chat-vllm already running"
fi

if [ -z "$HEALTH_WAIT_REASON" ] && [ "$CHAT_VLLM_ENABLED" = "1" ]; then
  echo "Waiting for voice sidecars to load before starting chat vLLM..."
  # Voice can take ~5-10s with cached models; first-run weight pull can
  # be minutes (Parakeet ~1.5 GB, Kokoro ~250 MB). 600s upper bound is
  # generous; if voice fails terminally, /health flips to 200 with
  # voice:"failed" sooner so we proceed without blocking the stack.
  VOICE_HEALTH_TIMEOUT="${VOICE_HEALTH_TIMEOUT:-600}"
  voice_elapsed=0
  voice_ok=0
  while [ "$voice_elapsed" -lt "$VOICE_HEALTH_TIMEOUT" ]; do
    if curl -fsS --max-time 5 "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
      voice_ok=1
      break
    fi
    sleep 2
    voice_elapsed=$((voice_elapsed + 2))
    # Progress nag every 30s so the user knows it isn't hung.
    if [ $((voice_elapsed % 30)) -eq 0 ]; then
      echo "  ...still waiting (${voice_elapsed}s elapsed)"
    fi
  done
  if [ "$voice_ok" -eq 1 ]; then
    voice_state=$(curl -fsS --max-time 5 "http://localhost:$BACKEND_PORT/health" 2>/dev/null \
      | grep -oP '"voice":"[^"]*"' | head -1 || echo '"voice":"?"')
    echo "Voice ready ($voice_state). Starting chat vLLM..."
  else
    echo "Voice didn't reach /health within ${VOICE_HEALTH_TIMEOUT}s — starting chat vLLM anyway."
  fi
elif [ -n "$HEALTH_WAIT_REASON" ]; then
  echo "Skipping voice-first wait: $HEALTH_WAIT_REASON."
fi

# Now actually launch the chat vLLM container if needed.
if [ "$CHAT_VLLM_ENABLED" = "1" ] && ! vllm_container_running "$CHAT_NAME"; then
  vllm_container_check_docker
  vllm_container_remove_stopped "$CHAT_NAME"
  vllm_container_pull_or_use "$CHAT_IMAGE"
  echo "Starting chat vLLM ($CHAT_NAME) on port $CHAT_PORT..."
  echo "  Model:  $CHAT_MODEL"
  echo "  Logs:   $PID_DIR/chat.log"

  vllm_container_run_detached \
    "$CHAT_NAME" "$CHAT_IMAGE" "$CHAT_PORT:8000" \
    "$PID_DIR/chat.cid" "$PID_DIR/chat.log" \
    --gpus all --ipc=host --shm-size=16g \
    -v "$HF_CACHE:/root/.cache/huggingface" \
    -- \
    "$CHAT_CMD" >/dev/null

  vllm_container_wait_health "$CHAT_NAME" "http://$CHAT_HOST:$CHAT_PORT/health" "$CHAT_HEALTH_TIMEOUT"
fi

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

  # Containerized init mode: when start.sh is PID 1 of a Docker
  # container (CMD invocation), exiting here would tear down the
  # container immediately, taking the backend + frontend with it.
  # Hold the foreground by tailing both log files, so:
  #   1. PID 1 stays alive → container stays alive
  #   2. backend + frontend logs stream to stdout → `docker compose logs`
  #      sees them
  #   3. if either child dies, the tail process notices its log
  #      stops growing — we use `wait -n` on the children's PIDs to
  #      actually exit when something fails, so compose can mark
  #      the container as failed and the user can debug.
  # In dev (shell/devcontainer), $$ != 1 — control returns to the
  # caller as before.
  if [ "$$" = "1" ]; then
    echo ""
    echo "  (PID 1: holding foreground for container lifecycle)"
    backend_pid="$(cat "$PID_DIR/backend.pid" 2>/dev/null)"
    frontend_pid="$(cat "$PID_DIR/frontend.pid" 2>/dev/null)"
    # Stream logs to stdout (docker compose captures from PID 1).
    tail -F --pid="$backend_pid" "$PID_DIR/backend.log" "$PID_DIR/frontend.log" &
    tail_pid=$!
    # Wait for whichever exits first: backend, frontend, or tail.
    # `wait -n` requires bash 4.3+; the vllm image has bash 5.x so OK.
    wait -n "$backend_pid" "$frontend_pid" "$tail_pid" 2>/dev/null
    echo ""
    echo "=== A Mica process exited; shutting down container ==="
    # Clean up remaining children
    kill "$backend_pid" "$frontend_pid" "$tail_pid" 2>/dev/null || true
    exit 1
  fi
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
