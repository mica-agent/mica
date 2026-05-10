#!/usr/bin/env bash
# Start Nemotron 3 Nano Omni in a separate vLLM container on port 8015.
# Used by the .voice-omni card class — replaces STT->LLM with a single
# audio-in pass through one model. Kokoro TTS still handles audio out.
#
# Why a separate container (not in-devcontainer)?
# - Nemotron Omni's architecture (NemotronH_Nano_Omni_Reasoning_V3) needs
#   vLLM 0.20.0+. NVCR's nvcr.io/nvidia/vllm:26.04-py3 (our devcontainer
#   base) ships vLLM 0.19.0 — the architecture isn't recognized. NVIDIA's
#   own model card recommends vllm/vllm-openai:v0.20.0 for DGX Spark.
# - Bumping the devcontainer to v0.20.0 would break llama.cpp compilation
#   (needs full CUDA toolkit / nvcc, which the upstream image strips out).
#   So omni gets its own container; the devcontainer stays at 26.04.
#
# All flags are lifted from the official model card recipe for DGX Spark,
# adjusted to coexist with llama-server (gpu-mem 0.7 instead of 0.8,
# max-model-len 32768 instead of 131072 to keep KV cache sane).
#
# Run from EITHER the host or inside the devcontainer — only requires
# `docker` on PATH.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
CID_FILE="$PID_DIR/omni.cid"
LOG_FILE="$PID_DIR/omni.log"

CONTAINER_NAME="${OMNI_CONTAINER_NAME:-mica-omni}"
PORT="${OMNI_PORT:-8015}"
IMAGE="${OMNI_IMAGE:-vllm/vllm-openai:v0.20.0}"
MODEL="${OMNI_MODEL:-nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"
HEALTH_TIMEOUT="${OMNI_HEALTH_TIMEOUT:-900}"

mkdir -p "$PID_DIR" "$HF_CACHE"

# Hard requirement: docker must be on PATH.
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH."
  echo "If you're inside the devcontainer, /var/run/docker.sock must be mounted."
  echo "Otherwise run this script from the host shell."
  exit 1
fi

# Idempotency: if container with this name already exists, skip or restart
# depending on its state.
existing_state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [ "$existing_state" = "running" ]; then
  echo "Omni container already running on port $PORT (name: $CONTAINER_NAME)"
  docker inspect -f '{{.Id}}' "$CONTAINER_NAME" > "$CID_FILE"
  exit 0
fi
if [ -n "$existing_state" ]; then
  echo "Removing stopped container: $CONTAINER_NAME (state: $existing_state)"
  docker rm "$CONTAINER_NAME" >/dev/null
fi
rm -f "$CID_FILE"

echo "Pulling $IMAGE (no-op if cached)..."
docker pull "$IMAGE"

echo "Starting Omni container on port $PORT..."
echo "  Image:    $IMAGE"
echo "  Model:    $MODEL"
echo "  HF cache: $HF_CACHE"
echo "  Log:      $LOG_FILE"

# Run detached. Mount the workspace HF cache so the 21 GB NVFP4 weights only
# download once. --shm-size=16g per the model card. Audio extras need
# vllm[audio] installed inside the container before serve.
#
# Recipe verbatim from the model card with Spark-specific tuning:
# - --gpu-memory-utilization 0.7 (vs card's 0.8) for headroom while
#   llama-server runs alongside
# - --max-model-len 32768 (vs card's 131072) to keep KV cache sane on
#   shared 128 GB unified memory
# - --max-num-seqs 8 (model card's Spark recommendation)
container_id="$(docker run -d \
  --name "$CONTAINER_NAME" \
  --gpus all \
  --ipc=host \
  --shm-size=16g \
  -p "$PORT:8000" \
  -v "$HF_CACHE:/root/.cache/huggingface" \
  --entrypoint /bin/bash \
  "$IMAGE" -c "pip install --quiet 'vllm[audio]' && \
    vllm serve $MODEL \
      --host 0.0.0.0 \
      --port 8000 \
      --served-model-name omni nemotron_3_nano_omni \
      --trust-remote-code \
      --gpu-memory-utilization 0.25 \
      --max-model-len 8192 \
      --max-num-seqs 2 \
      --max-num-batched-tokens 8192 \
      --enable-prefix-caching \
      --mm-processor-cache-gb 0 \
      --limit-mm-per-prompt '{\"video\":1,\"image\":1,\"audio\":1}' \
      --media-io-kwargs '{\"video\":{\"fps\":2,\"num_frames\":256}}' \
      --allowed-local-media-path=/ \
      --reasoning-parser nemotron_v3 \
      --enable-auto-tool-choice \
      --tool-call-parser qwen3_coder")"
# NOTE: enable_thinking=false is NOT a serve-time flag in vLLM 0.20 — it's
# a per-request chat_template_kwargs field. The voice handler MUST pass
# extra_body={"chat_template_kwargs":{"enable_thinking":false}} on every
# request, plus include "/no_think" in the system prompt as defense-in-depth.
# Otherwise the model burns hundreds of tokens reasoning before content emits.

# --mm-processor-cache-gb 0 disables the multimodal preprocessor cache to
# work around https://github.com/vllm-project/vllm/issues/31404 — a race
# between P0/P1 caches that crashes the engine on cache misses (PR #34749
# in draft as of Apr 2026 would fix it). For single-stream voice use
# there's no throughput cost to disabling this cache.
#
# --reasoning-parser nemotron_v3 stays ON: this is a Reasoning-variant
# model (only flavor available for Nemotron-3-Nano-Omni); the parser
# separates chain-of-thought into the `reasoning` field so the handler
# can ignore it. The voice handler will set max_tokens high (e.g. 512) so
# reasoning has room to finish AND content gets emitted; speaking only
# from `content`, not `reasoning`.

echo "$container_id" > "$CID_FILE"
echo "  Container: $container_id"

# Stream container logs to a host-side log file so the user can tail it
# during the long first boot. Detach the tail with disown so it doesn't
# block this script.
( docker logs -f "$CONTAINER_NAME" >"$LOG_FILE" 2>&1 ) &
disown

# Health wait. NVFP4 first-load is ~5 min (download 21 GB if cold + load +
# JIT). Subsequent starts ~90 s. Warn at 30 s intervals.
echo ""
echo "Waiting for /health on port $PORT (timeout ${HEALTH_TIMEOUT}s)..."
elapsed=0
last_warn=0
while ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; do
  cstate="$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo gone)"
  if [ "$cstate" != "running" ]; then
    echo "Container died during startup (state: $cstate). Last 40 log lines:"
    docker logs --tail 40 "$CONTAINER_NAME" 2>&1 || true
    rm -f "$CID_FILE"
    exit 1
  fi
  if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
    echo "Health check timed out after ${HEALTH_TIMEOUT}s. Container still running; inspect $LOG_FILE."
    exit 1
  fi
  if [ $((elapsed - last_warn)) -ge 30 ] && [ "$elapsed" -gt 0 ]; then
    echo "  ...still waiting (${elapsed}s; first boot can be 5-10 min for download + load)"
    last_warn=$elapsed
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done

echo ""
echo "=== Omni container is running ==="
echo "  Container: $CONTAINER_NAME ($container_id)"
echo "  Port:      $PORT"
echo "  Model:     $MODEL"
echo "  Logs:      $LOG_FILE  (or: docker logs -f $CONTAINER_NAME)"
echo "  Stop:      bash scripts/stop-omni.sh"
