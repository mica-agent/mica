#!/usr/bin/env python3
"""voice-stt-server.py — Parakeet STT sidecar.

Long-lived HTTP server that hosts Parakeet-TDT-0.6b-v2 in memory and
exposes a single /transcribe endpoint. Mica's Node backend posts audio
blobs and receives the transcription back as JSON.

Spawned by server/voiceServers.ts at Mica startup. Killed on shutdown.

Listens on 127.0.0.1 only — never accessible outside the host. Auth
isn't needed because the surface is localhost; same posture as
llama-server.

Audio handling: librosa load → 16kHz mono float32 → Parakeet. Accepts
any common audio format MediaRecorder produces (webm/opus, ogg, wav,
m4a) since librosa+soundfile auto-detect.

Usage:
    python voice-stt-server.py [--port 8013] [--host 127.0.0.1]

Env overrides:
    VOICE_STT_PORT  default 8013
    VOICE_STT_HOST  default 127.0.0.1
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

# Lazy imports — these are slow and we want fast --help / arg-parse.
# The model load happens in the lifespan handler.

DEFAULT_PORT = int(os.environ.get("VOICE_STT_PORT", "8013"))
DEFAULT_HOST = os.environ.get("VOICE_STT_HOST", "127.0.0.1")

_model = None  # type: ignore


def load_model():
    """Load Parakeet once, lazily, and cache."""
    global _model
    if _model is not None:
        return _model
    import nemo.collections.asr as nemo_asr  # type: ignore

    print("[voice-stt] loading Parakeet-TDT-0.6b-v2 ...", flush=True)
    t0 = time.perf_counter()
    _model = nemo_asr.models.ASRModel.from_pretrained(
        model_name="nvidia/parakeet-tdt-0.6b-v2"
    )
    _model.eval()
    print(f"[voice-stt] model loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    return _model


@asynccontextmanager
async def lifespan(app):
    # Model load on startup — not on first request — so /health latency
    # reflects readiness.
    load_model()
    yield


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()

    # Imports here so --help works without FastAPI installed (useful for
    # diagnostic flows).
    from fastapi import FastAPI, File, HTTPException, UploadFile
    import uvicorn  # type: ignore

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict:
        return {"ok": _model is not None, "model": "nvidia/parakeet-tdt-0.6b-v2"}

    @app.post("/transcribe")
    async def transcribe(audio: UploadFile = File(...)) -> dict:
        """Accept an audio file (any format librosa understands), return text.

        Returns: { "text": str, "duration_s": float, "elapsed_ms": int }
        """
        if _model is None:
            raise HTTPException(503, "model not loaded yet")

        # Read upload into a tempfile — librosa wants a path or file-like.
        # NamedTemporaryFile on Linux gives us a path immediately.
        suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tf:
            content = await audio.read()
            tf.write(content)
            tf.flush()

            # Re-encode to 16kHz mono wav for Parakeet. librosa+soundfile
            # auto-detects the input format. The intermediate wav is also
            # held in a tempfile so NeMo's path-based transcribe call works.
            try:
                import librosa  # type: ignore
                import soundfile as sf  # type: ignore
            except ImportError as e:
                raise HTTPException(500, f"missing audio deps: {e}") from e

            t0 = time.perf_counter()
            try:
                wave, _sr = librosa.load(tf.name, sr=16000, mono=True)
            except Exception as e:
                raise HTTPException(400, f"failed to decode audio: {e}") from e
            duration = len(wave) / 16000

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as wav_tf:
                sf.write(wav_tf.name, wave, 16000)
                wav_tf.flush()
                try:
                    hyps = _model.transcribe(
                        [wav_tf.name], batch_size=1, verbose=False
                    )
                except Exception as e:
                    raise HTTPException(500, f"transcription failed: {e}") from e
                # NeMo returns Hypothesis objects (or strings on older versions).
                first = hyps[0] if hyps else None
                text = (
                    getattr(first, "text", first)
                    if first is not None and not isinstance(first, str)
                    else (first or "")
                )

            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return {
                "text": str(text),
                "duration_s": duration,
                "elapsed_ms": elapsed_ms,
            }

    print(f"[voice-stt] listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
