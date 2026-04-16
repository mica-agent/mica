#!/bin/bash
# Start SGLang VLM server (Gemma 4 26B MoE) on port 8013
# Used by the Rex pipeline for scene understanding

MODEL="${VLM_MODEL:-google/gemma-4-26b-a4b-it}"
PORT=8013

echo "Starting VLM server (Gemma 4 26B) on port $PORT..."
echo "  Model: $MODEL"

exec python3 -m sglang.launch_server \
  --model "$MODEL" \
  --host 0.0.0.0 \
  --port $PORT \
  --enable-multimodal \
  --mem-fraction-static 0.2
