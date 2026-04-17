#!/bin/bash
# Start vLLM VLM server (Gemma 4 26B-A4B FP8) on port 8013
# Used by the Rex pipeline for scene understanding
# Native video input — no manual frame extraction needed
#
# FP8 chosen over NVFP4 for stability — vLLM 0.15.1 has SM120 cutlass
# kernel JIT issues with NVFP4 MoE quantization. Switch back when fixed.

MODEL="${VLM_MODEL:-RedHatAI/gemma-4-26B-A4B-it-FP8-Dynamic}"
PORT=8013

# vLLM is in container's system Python (not the venv)
PYTHON="${SGLANG_PYTHON:-/usr/bin/python3}"

echo "Starting VLM server on port $PORT..."
echo "  Model: $MODEL"

export VLLM_FLASHINFER_MOE_BACKEND=latency
export FLASHINFER_WORKSPACE_BASE=/home/vscode/.cache/flashinfer
export FLASHINFER_JIT_DIR=/home/vscode/.cache/flashinfer/jit

# Aliases so the llm-chat card's "vlm" model name resolves
exec vllm serve "$MODEL" \
  --host 0.0.0.0 \
  --port $PORT \
  --trust-remote-code \
  --gpu-memory-utilization 0.18 \
  --limit-mm-per-prompt '{"image":4,"video":1}' \
  --kv-cache-dtype fp8 \
  --enable-prefix-caching \
  --served-model-name vlm gemma "$MODEL"
