# Voice-stack latency benchmark for Mica on DGX Spark

Validates the proposed launch-demo voice stack
(**Parakeet-TDT-0.6b-v2** for STT + **Kokoro-82M** for TTS, alongside
the existing Qwen3.6 main agent) against real-world latency targets
on Spark hardware. Run before committing to the implementation —
published RTF / first-audio numbers don't always survive contention
with the main LLM on the same GPU.

The full design rationale is in
[`/home/vscode/.claude/plans/question-check-logs-swirling-castle.md`](../../../home/vscode/.claude/plans/question-check-logs-swirling-castle.md).

## What gets measured

| Phase | What it answers |
|---|---|
| Solo | Do Parakeet and Kokoro hit their published numbers on this Spark? |
| Contention | Does Qwen3.6 generating concurrently slow STT/TTS materially? |
| Pipeline | Total round-trip from audio-in to first audio-out |

Targets:

- **STT**: real-time factor < 0.1; end-of-utterance latency < 300 ms
- **TTS**: time-to-first-audio < 300 ms
- **Pipeline (batch)**: total round-trip < 700 ms
- **Pipeline (streaming)**: first audio chunk < 500 ms perceived
- **Memory**: total resident set < 40 GB (leaves 80 GB+ headroom)

## Run

```bash
# First time: install deps + download models + sample audio
bash scripts/benchmarks/voice/install.sh

# Run all benchmarks (5–10 min)
bash scripts/benchmarks/voice/run-all.sh

# View summary
python3 scripts/benchmarks/voice/summarize.py
```

`install.sh` creates a venv at `scripts/benchmarks/voice/.venv` and
downloads Parakeet (~1.5 GB) + Kokoro (~330 MB) on first run. Doesn't
touch Mica's existing setup. `run-all.sh` writes JSON results to
`scripts/benchmarks/voice/results/<date>.json`. `summarize.py` reads
the latest result file and prints a verdict.

## Assumptions

- llama-server is already running on `127.0.0.1:8012` (Mica's
  default). The benchmarks hit that endpoint for the LLM portion.
  Start Mica via `bash scripts/start.sh` (or
  `bash scripts/mica.sh start` for the Docker path) before running
  contention/pipeline benchmarks.
- Python 3.10+ available on PATH. The Spark's devcontainer image
  ships with Python 3.12.
- ~5 GB free disk for model caches (Parakeet + Kokoro).
- ~10 GB free GPU memory beyond what Qwen3.6 occupies (Spark has
  this comfortably).

## Decision criteria

After running, look at `summarize.py`'s verdict:

| Outcome | Action |
|---|---|
| All targets met | Lock in stack; proceed to STT pipeline implementation. |
| STT degrades >50% under contention | Try dedicated CUDA stream; or swap to distil-whisper. |
| TTS first-audio >500 ms even solo | Try Piper as faster fallback; or accept tradeoff. |
| LLM TTFT >800 ms under contention | Voice-mode prompt-cache pinning; revisit prompt structure. |
| Memory >50 GB resident | Drop mmproj for voice mode; or smaller LLM quant. |
| Audio quality unacceptable to ear | Swap Kokoro → F5-TTS at +1.5 GB cost. |

## Files

- `install.sh` — venv setup + model downloads + sample audio
- `bench_parakeet.py` — solo STT timing
- `bench_kokoro.py` — solo TTS timing
- `bench_qwen_baseline.py` — solo LLM TTFT/tok-s baseline
- `bench_contention.py` — STT+TTS during active LLM generation
- `bench_pipeline.py` — end-to-end audio→text→LLM→audio
- `summarize.py` — JSON results → markdown verdict
- `run-all.sh` — orchestrator (runs all 5 bench scripts in order)
- `audio/` — small bundled test clips (downloaded by install.sh)
- `results/` — JSON output from each run, timestamped

## Out of scope

This benchmark does NOT implement:
- The `.voice` card class
- Browser audio capture / WebSocket streaming
- VAD endpointing, barge-in, echo cancellation
- Multilingual STT (Canary fallback)
- Voice cloning (F5-TTS fallback)

Those are downstream ships; this benchmark validates whether the
chosen stack is worth shipping.
