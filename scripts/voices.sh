#!/usr/bin/env bash
# scripts/voices.sh — unified controller for the optional voice/omni
# experiment containers. Replaces start-omni.sh / stop-omni.sh /
# start-qwen-omni.sh / stop-qwen-omni.sh.
#
# Usage:
#   voices.sh start nemotron      # Nemotron-3-Nano-Omni-NVFP4 on :8015
#   voices.sh start qwen-omni     # Qwen3-Omni-30B-A3B-Instruct on :8016
#   voices.sh stop  nemotron|qwen-omni|all
#   voices.sh status              # show what's running
#
# These containers are A/B/C experiments — the .voice-omni and
# .voice-qwen-omni card classes connect to them when present, but they
# aren't part of the default Mica stack. Boot them when you want to
# compare voice paths; stop them to free GPU memory.
#
# Both omni variants are mutually exclusive (memory) — voices.sh
# enforces by stopping the other before starting one.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.mica-pids"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"
HEALTH_TIMEOUT="${VOICES_HEALTH_TIMEOUT:-900}"

mkdir -p "$PID_DIR" "$HF_CACHE"

# shellcheck source=lib/vllm-container.sh
. "$PROJECT_DIR/scripts/lib/vllm-container.sh"

usage() {
  echo "Usage: voices.sh start nemotron|qwen-omni"
  echo "       voices.sh stop  nemotron|qwen-omni|all"
  echo "       voices.sh status"
  exit 1
}

# ── Variant configs ──────────────────────────────────────────────
# Each variant defines: container name, host port, image, model id,
# extra docker args, vllm serve flags. Kept terse — the heavy lifting
# is in lib/vllm-container.sh.

start_nemotron() {
  vllm_container_check_docker
  if vllm_container_running "mica-qwen-omni"; then
    echo "ERROR: mica-qwen-omni is running. Stop it first: voices.sh stop qwen-omni" >&2
    exit 1
  fi
  if vllm_container_running "mica-omni"; then
    echo "mica-omni already running on :8015"
    exit 0
  fi
  vllm_container_remove_stopped "mica-omni"

  local image="${OMNI_IMAGE:-vllm/vllm-openai:v0.20.0}"
  local model="${OMNI_MODEL:-nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4}"
  local port=8015

  vllm_container_pull_or_use "$image"
  echo "Starting Nemotron Omni on port $port..."

  # vllm[audio] install + serve. NVFP4 + reasoning_v3 + qwen3_coder
  # tool parser per NVIDIA's model card, with Spark coexistence tuning
  # (gpu-mem 0.25, max-model-len 8192, max-num-seqs 2). mm-processor-cache-gb 0
  # works around vllm-project/vllm#31404.
  local container_cmd
  container_cmd=$(cat <<EOF
pip install --quiet 'vllm[audio]' && \
vllm serve $model \
  --host 0.0.0.0 --port 8000 \
  --served-model-name omni nemotron_3_nano_omni \
  --trust-remote-code \
  --gpu-memory-utilization 0.25 \
  --max-model-len 8192 \
  --max-num-seqs 2 \
  --max-num-batched-tokens 8192 \
  --enable-prefix-caching \
  --mm-processor-cache-gb 0 \
  --limit-mm-per-prompt '{"video":1,"image":1,"audio":1}' \
  --media-io-kwargs '{"video":{"fps":2,"num_frames":256}}' \
  --allowed-local-media-path=/ \
  --reasoning-parser nemotron_v3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
EOF
)

  vllm_container_run_detached \
    "mica-omni" "$image" "$port:8000" \
    "$PID_DIR/omni.cid" "$PID_DIR/omni.log" \
    --gpus all --ipc=host --shm-size=16g \
    -v "$HF_CACHE:/root/.cache/huggingface" \
    -- \
    "$container_cmd" >/dev/null

  vllm_container_wait_health "mica-omni" "http://localhost:$port/health" "$HEALTH_TIMEOUT"
  echo "Nemotron Omni ready on :$port"
}

start_qwen_omni() {
  vllm_container_check_docker
  if vllm_container_running "mica-omni"; then
    echo "ERROR: mica-omni (Nemotron) is running. Stop it first: voices.sh stop nemotron" >&2
    exit 1
  fi
  if vllm_container_running "mica-qwen-omni"; then
    echo "mica-qwen-omni already running on :8016"
    exit 0
  fi
  vllm_container_remove_stopped "mica-qwen-omni"

  local image="${QWEN_OMNI_IMAGE:-mica-vllm-omni:local}"
  local model="${QWEN_OMNI_MODEL:-Qwen/Qwen3-Omni-30B-A3B-Instruct}"
  local port=8016
  local deploy_config_host="$PROJECT_DIR/scripts/configs/qwen3-omni-spark.yaml"
  local deploy_config_container="/app/configs/qwen3-omni-spark.yaml"

  # Pre-flight: GPU memory must be ≥70 GB free for BF16. If llama-server
  # or other processes are squatting on memory, fail clean.
  if command -v nvidia-smi >/dev/null 2>&1; then
    local free_mib
    free_mib=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1)
    if [ -n "$free_mib" ] && [ "$free_mib" != "[N/A]" ] && [[ "$free_mib" =~ ^[0-9]+$ ]] && [ "$free_mib" -lt 70000 ]; then
      local free_gb=$((free_mib / 1024))
      echo "ERROR: Only ${free_gb} GB GPU memory free — Qwen3-Omni BF16 needs ~67 GB." >&2
      echo "Stop the chat vLLM container or other GPU consumers first." >&2
      [ "${VOICES_SKIP_MEMCHECK:-0}" = "1" ] || exit 1
    fi
  fi

  vllm_container_pull_or_use "$image"
  echo "Starting Qwen3-Omni on port $port..."

  local container_cmd
  container_cmd=$(cat <<EOF
pip install --quiet 'vllm[audio]' && \
vllm serve $model \
  --host 0.0.0.0 --port 8000 \
  --served-model-name qwen-omni qwen3_omni \
  --dtype bfloat16 \
  --trust-remote-code \
  --omni \
  --deploy-config $deploy_config_container \
  --mm-processor-cache-gb 0 \
  --limit-mm-per-prompt '{"video":1,"image":1,"audio":1}' \
  --allowed-local-media-path=/ \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml
EOF
)

  vllm_container_run_detached \
    "mica-qwen-omni" "$image" "$port:8000" \
    "$PID_DIR/qwen-omni.cid" "$PID_DIR/qwen-omni.log" \
    --gpus all --ipc=host --shm-size=16g \
    -v "$HF_CACHE:/root/.cache/huggingface" \
    -v "${deploy_config_host}:${deploy_config_container}:ro" \
    -- \
    "$container_cmd" >/dev/null

  vllm_container_wait_health "mica-qwen-omni" "http://localhost:$port/health" "$HEALTH_TIMEOUT"
  echo "Qwen3-Omni ready on :$port"
}

stop_nemotron() {
  vllm_container_check_docker
  vllm_container_stop "mica-omni"
  rm -f "$PID_DIR/omni.cid"
}

stop_qwen_omni() {
  vllm_container_check_docker
  vllm_container_stop "mica-qwen-omni"
  rm -f "$PID_DIR/qwen-omni.cid"
}

show_status() {
  printf '%-20s %s\n' "mica-omni (Nemotron)" "$(vllm_container_status mica-omni)"
  printf '%-20s %s\n' "mica-qwen-omni" "$(vllm_container_status mica-qwen-omni)"
}

# ── Dispatch ────────────────────────────────────────────────────
[ $# -ge 1 ] || usage
cmd="$1"; shift || true

case "$cmd" in
  start)
    [ $# -ge 1 ] || usage
    case "$1" in
      nemotron) start_nemotron ;;
      qwen-omni) start_qwen_omni ;;
      *) echo "Unknown voice variant: $1" >&2; usage ;;
    esac
    ;;
  stop)
    [ $# -ge 1 ] || usage
    case "$1" in
      nemotron) stop_nemotron ;;
      qwen-omni) stop_qwen_omni ;;
      all) stop_nemotron; stop_qwen_omni ;;
      *) echo "Unknown voice variant: $1" >&2; usage ;;
    esac
    ;;
  status) show_status ;;
  -h|--help|help) usage ;;
  *) echo "Unknown command: $cmd" >&2; usage ;;
esac
