#!/usr/bin/env python3
"""bench_parakeet.py — solo STT latency benchmark for Parakeet-TDT-0.6b-v2.

Loads the model once, transcribes each bundled audio clip N_TRIALS times
to capture variance, and writes a JSON report next to the script.

Solo measurement only — bench_contention.py covers the with-LLM case.

Usage:
    python bench_parakeet.py [--trials N] [--output PATH]
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
AUDIO_DIR = HERE / "audio"
RESULTS_DIR = HERE / "results"
DEFAULT_TRIALS = 3

CLIPS = ["clip_5s", "clip_10s", "clip_30s"]


def load_audio(name: str) -> tuple[Any, int, float]:
    """Return (waveform, sample_rate, duration_sec) or raise FileNotFoundError."""
    import soundfile as sf

    for ext in (".wav", ".flac"):
        path = AUDIO_DIR / f"{name}{ext}"
        if path.exists():
            data, sr = sf.read(path)
            duration = len(data) / sr
            return data, sr, duration
    raise FileNotFoundError(f"{name} not found in {AUDIO_DIR} (neither .wav nor .flac)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    print("[parakeet] loading model (Parakeet-TDT-0.6b-v2) ...", flush=True)
    load_start = time.perf_counter()
    # NeMo's ASRModel.from_pretrained pulls the model on first call and
    # caches at ~/.cache/torch/NeMo. Subsequent runs are local-only.
    import nemo.collections.asr as nemo_asr  # type: ignore

    model = nemo_asr.models.ASRModel.from_pretrained(
        model_name="nvidia/parakeet-tdt-0.6b-v2"
    )
    model.eval()
    load_time = time.perf_counter() - load_start
    print(f"[parakeet] model loaded in {load_time:.1f}s", flush=True)

    results: dict[str, Any] = {
        "model": "nvidia/parakeet-tdt-0.6b-v2",
        "load_time_s": load_time,
        "trials": args.trials,
        "clips": {},
    }

    for clip in CLIPS:
        try:
            wave, sr, dur = load_audio(clip)
        except FileNotFoundError as e:
            print(f"[parakeet] SKIP {clip}: {e}", flush=True)
            results["clips"][clip] = {"error": str(e)}
            continue

        print(f"[parakeet] benchmarking {clip} (duration {dur:.2f}s) ...", flush=True)
        clip_audio_path = AUDIO_DIR / f"{clip}.wav"
        if not clip_audio_path.exists():
            clip_audio_path = AUDIO_DIR / f"{clip}.flac"

        latencies: list[float] = []
        rtfs: list[float] = []
        last_text = ""

        for t in range(args.trials):
            t0 = time.perf_counter()
            # NeMo's transcribe accepts a list of file paths and returns
            # a list of Hypothesis objects (or strings on older versions).
            hyps = model.transcribe([str(clip_audio_path)], batch_size=1, verbose=False)
            elapsed = time.perf_counter() - t0
            latencies.append(elapsed)
            rtfs.append(elapsed / dur)
            # Hypothesis objects have a `.text` attr; older versions return raw strings.
            txt = hyps[0]
            last_text = getattr(txt, "text", txt) if not isinstance(txt, str) else txt
            print(f"  trial {t + 1}: {elapsed * 1000:.0f}ms (RTF {elapsed / dur:.3f})", flush=True)

        results["clips"][clip] = {
            "duration_s": dur,
            "trial_latencies_s": latencies,
            "trial_rtfs": rtfs,
            "median_latency_ms": statistics.median(latencies) * 1000,
            "p95_latency_ms": (sorted(latencies)[int(len(latencies) * 0.95)] if len(latencies) > 1 else latencies[0]) * 1000,
            "median_rtf": statistics.median(rtfs),
            "transcript_sample": (last_text[:120] if isinstance(last_text, str) else str(last_text)[:120]),
        }

    out = args.output or (RESULTS_DIR / f"parakeet-{int(time.time())}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"[parakeet] wrote {out}", flush=True)

    # Console summary
    print("\n=== Parakeet summary ===")
    for clip, data in results["clips"].items():
        if "error" in data:
            print(f"  {clip}: SKIPPED ({data['error']})")
            continue
        print(f"  {clip}: median={data['median_latency_ms']:.0f}ms  RTF={data['median_rtf']:.3f}")


if __name__ == "__main__":
    main()
