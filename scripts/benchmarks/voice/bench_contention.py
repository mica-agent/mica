#!/usr/bin/env python3
"""bench_contention.py — STT + TTS latency under concurrent LLM load.

The realistic operating point for Mica's voice mode: Qwen3.6 is
generating a response at the same time Parakeet/Kokoro are running
(transcribing the user's NEXT utterance, or speaking the previous
sentence). All three contend for GPU bandwidth on the same Spark.

Setup per trial:
1. Start a long-ish (200-token) Qwen3.6 streaming completion in a
   background thread.
2. Wait until Qwen has emitted ~50 tokens (steady state, past prefill).
3. Fire Parakeet on a 5-second clip and Kokoro on a 50-char text
   simultaneously (each in its own thread).
4. Measure their latencies under contention.
5. Wait for Qwen to finish; measure the mid-completion tok/s rate.

Compare results against bench_qwen_baseline.json + bench_parakeet.json
+ bench_kokoro.json to see how much each stage degrades under load.

Usage:
    python bench_contention.py [--trials N] [--url URL]
"""
from __future__ import annotations

import argparse
import json
import statistics
import threading
import time
from pathlib import Path
from typing import Any

import requests

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
AUDIO_DIR = HERE / "audio"
DEFAULT_URL = "http://127.0.0.1:8012"
DEFAULT_TRIALS = 3

# Same prompt as the baseline so the LLM cost is comparable.
PROMPT = (
    "You are a helpful assistant. Briefly explain what makes a "
    "real-time conversational AI system feel responsive."
)
TTS_TEXT = "Mica is a canvas where you and your agents work together."  # ~55 chars


class QwenStreamThread(threading.Thread):
    """Runs a Qwen completion in the background, exposing the moment
    when ~50 tokens have been emitted (so the contention test fires
    at steady state, not during prefill).
    """

    def __init__(self, url: str, fire_at_token: int = 50, max_tokens: int = 200):
        super().__init__(daemon=True)
        self.url = url
        self.fire_at_token = fire_at_token
        self.max_tokens = max_tokens
        self.fire_event = threading.Event()
        self.first_token_t: float | None = None
        self.token_count = 0
        self.total_time: float | None = None
        self.error: Exception | None = None
        # Tokens generated AFTER the contention window opens — used to
        # measure tok/s during contention.
        self._token_times: list[float] = []

    def run(self) -> None:
        body = {
            "model": "qwen",
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": self.max_tokens,
            "stream": True,
            "temperature": 0.7,
        }
        t0 = time.perf_counter()
        try:
            with requests.post(
                f"{self.url}/v1/chat/completions",
                json=body,
                stream=True,
                timeout=120,
            ) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line or not line.startswith(b"data: "):
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
                    if delta.get("content"):
                        now = time.perf_counter()
                        if self.first_token_t is None:
                            self.first_token_t = now
                        self.token_count += 1
                        self._token_times.append(now)
                        if self.token_count == self.fire_at_token:
                            self.fire_event.set()
            self.total_time = time.perf_counter() - t0
        except Exception as e:
            self.error = e
            self.fire_event.set()  # unblock waiter on error

    def tokens_after(self, t_start: float, t_end: float) -> int:
        return sum(1 for t in self._token_times if t_start <= t <= t_end)


def time_parakeet(model, clip_path: Path) -> float:
    t0 = time.perf_counter()
    model.transcribe([str(clip_path)], batch_size=1, verbose=False)
    return time.perf_counter() - t0


def time_kokoro_first_audio(pipeline, voice: str, text: str) -> float:
    t0 = time.perf_counter()
    for _idx, _gs, _audio in pipeline(text, voice=voice):
        return time.perf_counter() - t0
    # Empty generator — degenerate case
    return time.perf_counter() - t0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--voice", default="af_bella")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    # Probe llama-server.
    try:
        requests.get(f"{args.url}/health", timeout=5).raise_for_status()
    except Exception as e:
        print(f"[contention] llama-server not reachable at {args.url}: {e}")
        raise SystemExit(2)

    # Locate the 5s clip.
    clip_path: Path | None = None
    for ext in (".wav", ".flac"):
        p = AUDIO_DIR / f"clip_5s{ext}"
        if p.exists():
            clip_path = p
            break
    if not clip_path:
        print("[contention] clip_5s not found; run install.sh first")
        raise SystemExit(2)

    print("[contention] loading Parakeet ...", flush=True)
    import nemo.collections.asr as nemo_asr  # type: ignore

    asr = nemo_asr.models.ASRModel.from_pretrained(model_name="nvidia/parakeet-tdt-0.6b-v2")
    asr.eval()
    print("[contention] loading Kokoro ...", flush=True)
    from kokoro import KPipeline  # type: ignore

    tts = KPipeline(lang_code="a")

    # Warm up both with one untimed run so weights are paged in.
    print("[contention] warming up ...", flush=True)
    asr.transcribe([str(clip_path)], batch_size=1, verbose=False)
    for _ in tts(TTS_TEXT, voice=args.voice):
        break

    parakeet_latencies: list[float] = []
    kokoro_first_audio: list[float] = []
    qwen_during_rates: list[float] = []

    for t in range(args.trials):
        print(f"\n[contention] trial {t + 1}/{args.trials} ...", flush=True)
        qwen = QwenStreamThread(args.url, fire_at_token=50, max_tokens=200)
        qwen.start()

        # Wait until Qwen is past prefill (50 tokens emitted).
        if not qwen.fire_event.wait(timeout=30):
            print("  Qwen never reached fire-at-token — skipping trial")
            continue
        if qwen.error:
            print(f"  Qwen error: {qwen.error}")
            continue

        # Snap timestamps so we can isolate the contention window.
        contention_start = time.perf_counter()

        # Fire Parakeet and Kokoro in their own threads simultaneously.
        p_lat: dict[str, float] = {}
        k_lat: dict[str, float] = {}

        def run_parakeet() -> None:
            assert clip_path is not None
            p_lat["latency_s"] = time_parakeet(asr, clip_path)

        def run_kokoro() -> None:
            k_lat["first_audio_s"] = time_kokoro_first_audio(tts, args.voice, TTS_TEXT)

        tp = threading.Thread(target=run_parakeet)
        tk = threading.Thread(target=run_kokoro)
        tp.start()
        tk.start()
        tp.join()
        tk.join()
        contention_end = time.perf_counter()

        # Wait for Qwen to finish.
        qwen.join(timeout=60)

        # Compute Qwen tok/s during the contention window.
        toks_during = qwen.tokens_after(contention_start, contention_end)
        secs_during = max(contention_end - contention_start, 1e-9)
        rate_during = toks_during / secs_during

        parakeet_latencies.append(p_lat["latency_s"])
        kokoro_first_audio.append(k_lat["first_audio_s"])
        qwen_during_rates.append(rate_during)
        print(
            f"  parakeet={p_lat['latency_s'] * 1000:.0f}ms  "
            f"kokoro_first_audio={k_lat['first_audio_s'] * 1000:.0f}ms  "
            f"qwen_tok/s_during={rate_during:.1f}",
            flush=True,
        )

    results: dict[str, Any] = {
        "url": args.url,
        "trials": args.trials,
        "voice": args.voice,
        "trial_parakeet_latency_s": parakeet_latencies,
        "trial_kokoro_first_audio_s": kokoro_first_audio,
        "trial_qwen_during_rate_tok_per_s": qwen_during_rates,
        "median_parakeet_latency_ms": (statistics.median(parakeet_latencies) * 1000) if parakeet_latencies else None,
        "median_kokoro_first_audio_ms": (statistics.median(kokoro_first_audio) * 1000) if kokoro_first_audio else None,
        "median_qwen_during_rate_tok_per_s": statistics.median(qwen_during_rates) if qwen_during_rates else None,
    }
    out = args.output or (RESULTS_DIR / f"contention-{int(time.time())}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"\n[contention] wrote {out}", flush=True)

    print("\n=== Contention summary ===")
    print(f"  Parakeet under load:  median={results['median_parakeet_latency_ms']:.0f}ms")
    print(f"  Kokoro first-audio:   median={results['median_kokoro_first_audio_ms']:.0f}ms")
    print(f"  Qwen tok/s during:    median={results['median_qwen_during_rate_tok_per_s']:.1f}")
    print(
        "\n  Compare against solo runs (parakeet/kokoro/qwen-baseline JSONs) to "
        "see contention overhead."
    )


if __name__ == "__main__":
    main()
