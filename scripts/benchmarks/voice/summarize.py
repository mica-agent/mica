#!/usr/bin/env python3
"""summarize.py — read latest JSON results and print a markdown verdict.

Combines outputs from bench_parakeet, bench_kokoro, bench_qwen_baseline,
bench_contention, and bench_pipeline. Compares against the targets in
the plan and outputs a per-target pass/fail table plus a recommendation.

Usage:
    python summarize.py [--results-dir DIR]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
DEFAULT_RESULTS = HERE / "results"

TARGETS = {
    "parakeet_rtf_max": 0.1,           # solo RTF must be < this
    "parakeet_latency_max_ms": 300,    # solo end-of-utterance latency
    "kokoro_first_audio_max_ms": 300,  # solo TTS first-audio
    "qwen_ttft_max_ms": 400,           # LLM solo TTFT
    "pipeline_streaming_max_ms": 500,  # end-to-end perceived latency
    "pipeline_batch_max_ms": 700,      # end-to-end batch round-trip
    "contention_overhead_max": 1.5,    # under-load latency / solo latency
    "qwen_under_load_min_rate": 0.8,   # under-load tok/s / baseline tok/s
}


def latest(results_dir: Path, prefix: str) -> Optional[Path]:
    candidates = sorted(results_dir.glob(f"{prefix}-*.json"))
    return candidates[-1] if candidates else None


def load(path: Optional[Path]) -> Optional[dict[str, Any]]:
    if not path:
        return None
    try:
        return json.loads(path.read_text())
    except Exception as e:
        print(f"  (failed to read {path}: {e})")
        return None


def fmt_ms(v: Optional[float]) -> str:
    if v is None:
        return "—"
    return f"{v:.0f}ms"


def fmt_ratio(v: Optional[float]) -> str:
    if v is None:
        return "—"
    return f"{v:.2f}"


def verdict(passed: bool) -> str:
    return "✅" if passed else "❌"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS)
    args = parser.parse_args()

    results_dir = args.results_dir
    if not results_dir.exists():
        print(f"No results in {results_dir}. Run run-all.sh first.")
        return

    parakeet = load(latest(results_dir, "parakeet"))
    kokoro = load(latest(results_dir, "kokoro"))
    qwen = load(latest(results_dir, "qwen-baseline"))
    contention = load(latest(results_dir, "contention"))
    pipeline = load(latest(results_dir, "pipeline"))

    rows: list[tuple[str, str, str, str]] = []  # (target, actual, target_str, status)

    # Parakeet solo RTF
    p_rtf = None
    p_lat = None
    if parakeet and parakeet.get("clips"):
        # Use the 5s clip as the canonical short-utterance number.
        c = parakeet["clips"].get("clip_5s") or {}
        p_rtf = c.get("median_rtf")
        p_lat = c.get("median_latency_ms")
    rows.append(
        (
            "Parakeet solo RTF (5s clip)",
            fmt_ratio(p_rtf),
            f"< {TARGETS['parakeet_rtf_max']}",
            verdict(p_rtf is not None and p_rtf < TARGETS["parakeet_rtf_max"]),
        )
    )
    rows.append(
        (
            "Parakeet solo latency (5s clip)",
            fmt_ms(p_lat),
            f"< {TARGETS['parakeet_latency_max_ms']}ms",
            verdict(p_lat is not None and p_lat < TARGETS["parakeet_latency_max_ms"]),
        )
    )

    # Kokoro solo first-audio (medium text)
    k_first = None
    if kokoro and kokoro.get("texts"):
        m = kokoro["texts"].get("medium_50c") or kokoro["texts"].get("short_10c") or {}
        k_first = m.get("median_first_audio_ms")
    rows.append(
        (
            "Kokoro solo first-audio (~70c)",
            fmt_ms(k_first),
            f"< {TARGETS['kokoro_first_audio_max_ms']}ms",
            verdict(k_first is not None and k_first < TARGETS["kokoro_first_audio_max_ms"]),
        )
    )

    # Qwen baseline TTFT
    q_ttft = qwen.get("median_ttft_ms") if qwen else None
    q_rate = qwen.get("median_rate_tok_per_s") if qwen else None
    rows.append(
        (
            "Qwen3.6 baseline TTFT",
            fmt_ms(q_ttft),
            f"< {TARGETS['qwen_ttft_max_ms']}ms",
            verdict(q_ttft is not None and q_ttft < TARGETS["qwen_ttft_max_ms"]),
        )
    )

    # Contention overhead
    c_par = contention.get("median_parakeet_latency_ms") if contention else None
    c_kok = contention.get("median_kokoro_first_audio_ms") if contention else None
    c_qrate = contention.get("median_qwen_during_rate_tok_per_s") if contention else None
    par_overhead = (c_par / p_lat) if (c_par and p_lat) else None
    kok_overhead = (c_kok / k_first) if (c_kok and k_first) else None
    qwen_throughput_ratio = (c_qrate / q_rate) if (c_qrate and q_rate) else None
    rows.append(
        (
            "Parakeet under load / solo",
            fmt_ratio(par_overhead),
            f"< {TARGETS['contention_overhead_max']}",
            verdict(par_overhead is not None and par_overhead < TARGETS["contention_overhead_max"]),
        )
    )
    rows.append(
        (
            "Kokoro under load / solo",
            fmt_ratio(kok_overhead),
            f"< {TARGETS['contention_overhead_max']}",
            verdict(kok_overhead is not None and kok_overhead < TARGETS["contention_overhead_max"]),
        )
    )
    rows.append(
        (
            "Qwen tok/s under load / solo",
            fmt_ratio(qwen_throughput_ratio),
            f"> {TARGETS['qwen_under_load_min_rate']}",
            verdict(
                qwen_throughput_ratio is not None
                and qwen_throughput_ratio > TARGETS["qwen_under_load_min_rate"]
            ),
        )
    )

    # Pipeline numbers
    pl_stream = pipeline.get("median_streaming_first_audio_ms") if pipeline else None
    pl_batch = pipeline.get("median_batch_total_ms") if pipeline else None
    rows.append(
        (
            "Pipeline streaming first-audio",
            fmt_ms(pl_stream),
            f"< {TARGETS['pipeline_streaming_max_ms']}ms",
            verdict(pl_stream is not None and pl_stream < TARGETS["pipeline_streaming_max_ms"]),
        )
    )
    rows.append(
        (
            "Pipeline batch total",
            fmt_ms(pl_batch),
            f"< {TARGETS['pipeline_batch_max_ms']}ms",
            verdict(pl_batch is not None and pl_batch < TARGETS["pipeline_batch_max_ms"]),
        )
    )

    # ── Print markdown report ────────────────────────────────────
    print("\n# Voice-stack benchmark verdict\n")
    print("| Metric | Actual | Target | Status |")
    print("|---|---|---|---|")
    for r in rows:
        print(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} |")

    # ── Recommendation ──────────────────────────────────────────
    failures = [r[0] for r in rows if r[3] == "❌"]
    print()
    if not failures:
        print("**Verdict: 🟢 ship the stack as designed.**")
        print()
        print("All targets met. Proceed to STT pipeline implementation.")
    else:
        print(f"**Verdict: 🟡 {len(failures)} target(s) missed.**")
        print()
        print("Failed targets:")
        for f in failures:
            print(f"  - {f}")
        print()
        print("Likely adjustments (see plan's Decision criteria table):")
        if any("Parakeet" in f for f in failures):
            print("  - Try a smaller STT model (distil-whisper, Moonshine)")
            print("  - Or dedicated CUDA stream for Parakeet")
        if any("Kokoro" in f for f in failures):
            print("  - Try Piper as a faster (lower-quality) fallback")
            print("  - Or accept the latency tradeoff if quality matters more")
        if any("Qwen" in f for f in failures):
            print("  - Voice-mode prompt-cache pinning")
            print("  - Smaller LLM quant (Q4_K_S?) for voice mode")
        if any("Pipeline" in f for f in failures):
            print("  - Investigate which stage is the bottleneck (look at solo numbers)")


if __name__ == "__main__":
    main()
