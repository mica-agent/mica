#!/usr/bin/env python3
"""bench_pipeline.py — end-to-end voice round-trip latency.

Closest approximation to what users experience in voice mode:

  audio in  →  Parakeet (STT)  →  Qwen3.6 (LLM)  →  Kokoro (TTS)  →  audio out

Reports two latencies:
  - **batch**  total wall-clock from audio-end to TTS finished
  - **streaming**  audio-end to first TTS audio chunk (when TTS starts
    on the first sentence boundary while LLM is still generating).
    This is the "perceived latency" — what the user actually feels.

Uses the 5-second clip from audio/ as the synthetic input. The LLM
gets a small prompt (50-token target completion) so total round-trip
is bounded.

Usage:
    python bench_pipeline.py [--trials N] [--url URL]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import time
from pathlib import Path
from typing import Any

import requests

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
AUDIO_DIR = HERE / "audio"
DEFAULT_URL = "http://127.0.0.1:8012"
DEFAULT_TRIALS = 3
DEFAULT_MAX_TOKENS = 50


def stream_chat_with_sentence_chunks(
    url: str, user_msg: str, max_tokens: int
) -> tuple[float, float, list[tuple[float, str]], str]:
    """Stream a chat completion and emit sentence-sized chunks.

    Returns (ttft, total, [(t, sentence), ...], full_text).
    Sentence boundaries detected by regex on accumulated text — same
    approximation we'd use in production for streaming-TTS handoff.
    """
    body = {
        "model": "qwen",
        "messages": [{"role": "user", "content": user_msg}],
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": 0.7,
    }
    t0 = time.perf_counter()
    first_token_t: float | None = None
    buf = ""
    sentences: list[tuple[float, str]] = []
    full = ""
    sentence_re = re.compile(r"([^.!?]+[.!?])")
    with requests.post(
        f"{url}/v1/chat/completions", json=body, stream=True, timeout=60
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
            content = (choices[0].get("delta") or {}).get("content")
            if not content:
                continue
            if first_token_t is None:
                first_token_t = time.perf_counter()
            buf += content
            full += content
            # Emit any complete sentences that have accumulated.
            while True:
                m = sentence_re.match(buf)
                if not m:
                    break
                sentence = m.group(1).strip()
                buf = buf[m.end() :].lstrip()
                if sentence:
                    sentences.append((time.perf_counter(), sentence))
    # Trailing partial buffer becomes a sentence.
    if buf.strip():
        sentences.append((time.perf_counter(), buf.strip()))
    total_t = time.perf_counter() - t0
    ttft = (first_token_t - t0) if first_token_t else float("nan")
    return ttft, total_t, sentences, full


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--voice", default="af_bella")
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    try:
        requests.get(f"{args.url}/health", timeout=5).raise_for_status()
    except Exception as e:
        print(f"[pipeline] llama-server not reachable at {args.url}: {e}")
        raise SystemExit(2)

    clip_path: Path | None = None
    for ext in (".wav", ".flac"):
        p = AUDIO_DIR / f"clip_5s{ext}"
        if p.exists():
            clip_path = p
            break
    if not clip_path:
        print("[pipeline] clip_5s missing; run install.sh first")
        raise SystemExit(2)

    print("[pipeline] loading models ...", flush=True)
    import nemo.collections.asr as nemo_asr  # type: ignore
    from kokoro import KPipeline  # type: ignore

    asr = nemo_asr.models.ASRModel.from_pretrained(model_name="nvidia/parakeet-tdt-0.6b-v2")
    asr.eval()
    tts = KPipeline(lang_code="a")

    # Warm up.
    asr.transcribe([str(clip_path)], batch_size=1, verbose=False)
    for _ in tts("Warm up.", voice=args.voice):
        break

    batch_totals: list[float] = []
    streaming_first_audio: list[float] = []

    for t in range(args.trials):
        print(f"\n[pipeline] trial {t + 1}/{args.trials}", flush=True)

        # User-finishes-speaking marker. Everything in the pipeline
        # measures relative to this.
        t_user_end = time.perf_counter()

        # 1. STT.
        hyps = asr.transcribe([str(clip_path)], batch_size=1, verbose=False)
        transcribed = getattr(hyps[0], "text", hyps[0]) if not isinstance(hyps[0], str) else hyps[0]
        t_stt_done = time.perf_counter()
        print(f"  STT      done at +{(t_stt_done - t_user_end) * 1000:.0f}ms — {str(transcribed)[:80]}")

        # 2. LLM with sentence-chunk emit.
        ttft, total, sentences, full_response = stream_chat_with_sentence_chunks(
            args.url, str(transcribed), args.max_tokens
        )
        t_first_sentence = sentences[0][0] if sentences else time.perf_counter()
        t_llm_done = time.perf_counter()
        print(
            f"  LLM      first-sentence at +{(t_first_sentence - t_user_end) * 1000:.0f}ms  "
            f"done at +{(t_llm_done - t_user_end) * 1000:.0f}ms",
        )

        # 3a. Streaming TTS — start as soon as first sentence is ready.
        first_sentence_text = sentences[0][1] if sentences else (full_response[:80] or "Done.")
        t_stream_tts_start = time.perf_counter()
        first_audio_t: float | None = None
        for _idx, _gs, _audio in tts(first_sentence_text, voice=args.voice):
            first_audio_t = time.perf_counter()
            break  # only need first chunk
        first_audio_offset_streaming = (first_audio_t or t_stream_tts_start) - t_user_end
        print(
            f"  TTS-stream  first-audio at +{first_audio_offset_streaming * 1000:.0f}ms  "
            f"(streaming start to first audio: "
            f"{((first_audio_t or t_stream_tts_start) - t_stream_tts_start) * 1000:.0f}ms)"
        )

        # 3b. Batch TTS — wait for full LLM response then synthesize.
        # Use the full response so cost is realistic.
        t_batch_tts_start = time.perf_counter()
        for _ in tts(full_response or "Done.", voice=args.voice):
            pass
        t_batch_tts_done = time.perf_counter()
        batch_total_offset = t_batch_tts_done - t_user_end
        print(f"  TTS-batch   done at +{batch_total_offset * 1000:.0f}ms")

        batch_totals.append(batch_total_offset)
        streaming_first_audio.append(first_audio_offset_streaming)

    results: dict[str, Any] = {
        "url": args.url,
        "trials": args.trials,
        "voice": args.voice,
        "max_llm_tokens": args.max_tokens,
        "trial_batch_total_s": batch_totals,
        "trial_streaming_first_audio_s": streaming_first_audio,
        "median_batch_total_ms": (statistics.median(batch_totals) * 1000) if batch_totals else None,
        "median_streaming_first_audio_ms": (statistics.median(streaming_first_audio) * 1000) if streaming_first_audio else None,
    }
    out = args.output or (RESULTS_DIR / f"pipeline-{int(time.time())}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"\n[pipeline] wrote {out}", flush=True)

    print("\n=== Pipeline summary ===")
    print(f"  Streaming first-audio (perceived):  median={results['median_streaming_first_audio_ms']:.0f}ms")
    print(f"  Batch total round-trip:              median={results['median_batch_total_ms']:.0f}ms")
    print()
    print("  Targets: streaming <500ms, batch <700ms")


if __name__ == "__main__":
    main()
