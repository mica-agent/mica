#!/usr/bin/env python3
"""bench_qwen_baseline.py — solo TTFT + tok/s baseline for the running llama-server.

Hits Mica's existing llama-server (default 127.0.0.1:8012) with a small
chat completion. Measures time-to-first-token and steady-state generation
rate. Used as the baseline for the contention test (which compares
under-load numbers against this).

Doesn't load a separate model — assumes Mica is running. Start Mica via
`bash scripts/start.sh` (or `bash scripts/mica.sh start` in Docker mode)
before invoking this benchmark.

Usage:
    python bench_qwen_baseline.py [--url URL] [--trials N] [--max-tokens N]
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Any

import requests

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
DEFAULT_URL = "http://127.0.0.1:8012"
DEFAULT_TRIALS = 3
DEFAULT_MAX_TOKENS = 200

# A representative prompt — small enough to not blow prefill time, large
# enough to be realistic. The voice-mode flow's prompts will be smaller
# (single user utterance + recent history), so this is conservative.
PROMPT = (
    "You are a helpful assistant. Briefly explain what makes a "
    "real-time conversational AI system feel responsive."
)


def stream_completion(url: str, max_tokens: int) -> tuple[float, float, int]:
    """Hit llama-server's /v1/chat/completions with stream=true.

    Returns (ttft_s, total_s, tokens_generated). TTFT is the wall-clock
    time from request-send to receipt of the first token-bearing chunk.
    """
    body = {
        "model": "qwen",
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": 0.7,
    }
    t0 = time.perf_counter()
    first_token_t: float | None = None
    tokens = 0
    with requests.post(
        f"{url}/v1/chat/completions",
        json=body,
        stream=True,
        timeout=60,
    ) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line:
                continue
            if not line.startswith(b"data: "):
                continue
            payload = line[len(b"data: ") :]
            if payload.strip() == b"[DONE]":
                break
            try:
                ev = json.loads(payload)
            except json.JSONDecodeError:
                continue
            choices = ev.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                if first_token_t is None:
                    first_token_t = time.perf_counter()
                tokens += 1
    total_t = time.perf_counter() - t0
    ttft = (first_token_t - t0) if first_token_t else float("nan")
    return ttft, total_t, tokens


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    print(f"[qwen-baseline] probing {args.url}/health ...", flush=True)
    try:
        h = requests.get(f"{args.url}/health", timeout=5)
        h.raise_for_status()
    except Exception as e:
        print(f"[qwen-baseline] llama-server not reachable: {e}")
        print("  Start Mica first: bash scripts/start.sh")
        raise SystemExit(2)

    print(f"[qwen-baseline] running {args.trials} trial(s) ({args.max_tokens} tokens each) ...", flush=True)
    ttfts: list[float] = []
    rates: list[float] = []  # tokens/sec steady-state (excludes prefill)
    for t in range(args.trials):
        ttft, total, tokens = stream_completion(args.url, args.max_tokens)
        # Steady-state rate: total tokens minus the first (which carries
        # prefill cost) divided by (total - ttft).
        steady_tokens = max(tokens - 1, 0)
        steady_secs = max(total - ttft, 1e-9)
        rate = steady_tokens / steady_secs if steady_tokens > 0 else 0
        ttfts.append(ttft)
        rates.append(rate)
        print(
            f"  trial {t + 1}: TTFT={ttft * 1000:.0f}ms  total={total * 1000:.0f}ms  "
            f"tokens={tokens}  steady_tok/s={rate:.1f}",
            flush=True,
        )

    results: dict[str, Any] = {
        "url": args.url,
        "max_tokens": args.max_tokens,
        "trials": args.trials,
        "trial_ttft_s": ttfts,
        "trial_rate_tok_per_s": rates,
        "median_ttft_ms": statistics.median(ttfts) * 1000,
        "median_rate_tok_per_s": statistics.median(rates),
    }
    out = args.output or (RESULTS_DIR / f"qwen-baseline-{int(time.time())}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"[qwen-baseline] wrote {out}", flush=True)

    print("\n=== Qwen baseline ===")
    print(
        f"  median TTFT: {results['median_ttft_ms']:.0f}ms   "
        f"median steady rate: {results['median_rate_tok_per_s']:.1f} tok/s"
    )


if __name__ == "__main__":
    main()
