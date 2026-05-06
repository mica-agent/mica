#!/usr/bin/env python3
"""bench_kokoro.py — solo TTS latency benchmark for Kokoro-82M.

Measures time-to-first-audio (the metric that determines perceived
latency in streaming voice UX) and total generation time across short,
medium, and long text inputs. Writes a JSON report.

Saves the first generated audio sample to disk for manual ear-quality
check — Kokoro's quality is part of the "should we use it?" decision.

Usage:
    python bench_kokoro.py [--trials N] [--output PATH] [--voice VOICE]
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
SAMPLES_DIR = HERE / "audio" / "kokoro_samples"
DEFAULT_TRIALS = 3

# Three text lengths to catch any non-linearity in generation.
TEXTS = {
    "short_10c": "Hello there.",  # ~10 chars
    "medium_50c": "Mica is a canvas where you and your agents work together on problems.",  # ~70 chars
    "long_200c": (
        "Mica turns your DGX Spark into a workshop where local AI agents "
        "do real work, including understanding video and speech. Drop a "
        "recording on the canvas and watch it summarize itself locally."
    ),  # ~210 chars
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument(
        "--voice",
        default="af_bella",
        help="Kokoro voice name. See https://huggingface.co/hexgrad/Kokoro-82M",
    )
    args = parser.parse_args()

    print("[kokoro] loading model (hexgrad/Kokoro-82M) ...", flush=True)
    load_start = time.perf_counter()
    # The kokoro Python package wraps the model. First import + KPipeline
    # construction triggers a one-time HF download (~330MB).
    from kokoro import KPipeline  # type: ignore

    pipeline = KPipeline(lang_code="a")  # 'a' = American English
    load_time = time.perf_counter() - load_start
    print(f"[kokoro] model loaded in {load_time:.1f}s", flush=True)

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

    results: dict[str, Any] = {
        "model": "hexgrad/Kokoro-82M",
        "voice": args.voice,
        "load_time_s": load_time,
        "trials": args.trials,
        "texts": {},
    }

    for label, text in TEXTS.items():
        char_count = len(text)
        print(
            f"[kokoro] benchmarking {label} ({char_count} chars) ...",
            flush=True,
        )
        first_audio_latencies: list[float] = []
        total_gen_times: list[float] = []
        first_audio_saved = False

        for t in range(args.trials):
            t0 = time.perf_counter()
            # Pipeline yields chunks (one per text segment). Capture
            # time of first chunk for first-audio latency.
            chunks: list = []
            first_chunk_time: float | None = None
            for _idx, _gs, audio in pipeline(text, voice=args.voice):
                if first_chunk_time is None:
                    first_chunk_time = time.perf_counter()
                chunks.append(audio)
            total_time = time.perf_counter() - t0
            first_audio_latencies.append((first_chunk_time or t0) - t0)
            total_gen_times.append(total_time)
            print(
                f"  trial {t + 1}: first_audio={(first_chunk_time or t0 - t0) * 1000:.0f}ms "
                f"total={total_time * 1000:.0f}ms",
                flush=True,
            )

            # Save the first trial's first chunk as a wav for ear check.
            if not first_audio_saved and chunks:
                try:
                    import numpy as np  # type: ignore
                    import soundfile as sf  # type: ignore

                    full = np.concatenate(chunks)
                    sample_path = SAMPLES_DIR / f"{label}_{args.voice}.wav"
                    sf.write(sample_path, full, 24000)
                    print(f"    saved sample → {sample_path}", flush=True)
                    first_audio_saved = True
                except Exception as e:
                    print(f"    (sample save failed: {e})", flush=True)

        results["texts"][label] = {
            "char_count": char_count,
            "trial_first_audio_s": first_audio_latencies,
            "trial_total_gen_s": total_gen_times,
            "median_first_audio_ms": statistics.median(first_audio_latencies) * 1000,
            "median_total_gen_ms": statistics.median(total_gen_times) * 1000,
            "chars_per_sec": char_count / statistics.median(total_gen_times),
        }

    out = args.output or (RESULTS_DIR / f"kokoro-{int(time.time())}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"[kokoro] wrote {out}", flush=True)

    # Console summary
    print("\n=== Kokoro summary ===")
    for label, data in results["texts"].items():
        print(
            f"  {label} ({data['char_count']}c): "
            f"first_audio={data['median_first_audio_ms']:.0f}ms  "
            f"total={data['median_total_gen_ms']:.0f}ms  "
            f"({data['chars_per_sec']:.0f} c/s)"
        )
    print(f"\n  Audio samples for ear check: {SAMPLES_DIR}/")


if __name__ == "__main__":
    main()
