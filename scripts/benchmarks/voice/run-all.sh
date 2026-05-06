#!/usr/bin/env bash
# run-all.sh — orchestrate the full voice-stack benchmark on Spark.
#
# Runs the five bench scripts in order, writes JSON results to
# results/, then invokes summarize.py to print the verdict.
#
# Total runtime: 5–10 min on Spark (model loads + ~3 trials per stage).
# First run is longer (~15 min) due to one-time model downloads.

set -euo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=""; C_DIM=""; C_RESET=""
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [ ! -d "$VENV" ]; then
  echo "venv not found — run install.sh first" >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$VENV/bin/activate"

# Probe llama-server before bothering with model loads.
if ! curl -sf "${MICA_LLAMA_URL:-http://127.0.0.1:8012}/health" >/dev/null 2>&1; then
  echo "llama-server not responding at ${MICA_LLAMA_URL:-http://127.0.0.1:8012}/health" >&2
  echo "Start Mica first: bash scripts/start.sh   (or scripts/mica.sh start in Docker mode)" >&2
  exit 2
fi

stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "${C_DIM}=== voice-stack benchmark ===${C_RESET}"
echo "  started: $(stamp)"
echo ""

echo "${C_OK}[1/5] Parakeet (solo STT)${C_RESET}"
python "$HERE/bench_parakeet.py"
echo ""

echo "${C_OK}[2/5] Kokoro (solo TTS)${C_RESET}"
python "$HERE/bench_kokoro.py"
echo ""

echo "${C_OK}[3/5] Qwen3.6 baseline (LLM)${C_RESET}"
python "$HERE/bench_qwen_baseline.py"
echo ""

echo "${C_OK}[4/5] Contention (STT + TTS during LLM)${C_RESET}"
python "$HERE/bench_contention.py"
echo ""

echo "${C_OK}[5/5] End-to-end pipeline${C_RESET}"
python "$HERE/bench_pipeline.py"
echo ""

echo "${C_DIM}=== summary ===${C_RESET}"
python "$HERE/summarize.py"

echo ""
echo "${C_DIM}finished: $(stamp)${C_RESET}"
echo ""
echo "Raw JSON results at: $HERE/results/"
echo "Audio samples (Kokoro ear-check) at: $HERE/audio/kokoro_samples/"
