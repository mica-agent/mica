#!/usr/bin/env python3
"""voice-tts-server.py — Kokoro TTS sidecar.

Long-lived HTTP server that hosts hexgrad/Kokoro-82M and exposes a
single /synthesize endpoint. Mica's Node backend posts text and
receives a WAV blob back.

Spawned by server/voiceServers.ts at Mica startup. Killed on shutdown.
Localhost-only.

Output format: WAV (PCM 16-bit, 24 kHz mono — Kokoro's native rate).
The browser plays this directly via <audio> or AudioContext without
re-encoding.

Usage:
    python voice-tts-server.py [--port 8014] [--host 127.0.0.1]

Env overrides:
    VOICE_TTS_PORT  default 8014
    VOICE_TTS_HOST  default 127.0.0.1
"""
# Match voice-stt-server.py: no `from __future__ import annotations` so
# FastAPI's Pydantic integration can resolve special types correctly.

import argparse
import io
import os
import time
from contextlib import asynccontextmanager

DEFAULT_PORT = int(os.environ.get("VOICE_TTS_PORT", "8014"))
DEFAULT_HOST = os.environ.get("VOICE_TTS_HOST", "127.0.0.1")
DEFAULT_VOICE = os.environ.get("VOICE_TTS_VOICE", "af_bella")

_pipeline = None  # type: ignore


def load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    from kokoro import KPipeline  # type: ignore

    print("[voice-tts] loading Kokoro-82M ...", flush=True)
    t0 = time.perf_counter()
    _pipeline = KPipeline(lang_code="a")  # "a" = American English
    print(f"[voice-tts] model loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    return _pipeline


@asynccontextmanager
async def lifespan(app):
    load_pipeline()
    yield


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()

    from fastapi import FastAPI, HTTPException
    from fastapi.responses import Response
    from pydantic import BaseModel
    import uvicorn  # type: ignore
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    class SynthesizeRequest(BaseModel):
        text: str
        voice: str | None = None  # falls back to DEFAULT_VOICE

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict:
        return {"ok": _pipeline is not None, "model": "hexgrad/Kokoro-82M"}

    @app.post("/synthesize")
    async def synthesize(req: SynthesizeRequest) -> Response:
        """Synthesize text → WAV bytes.

        Returns: audio/wav body. Headers carry timing + chars-per-sec for
        client-side metrics.
        """
        if _pipeline is None:
            raise HTTPException(503, "model not loaded yet")
        text = (req.text or "").strip()
        if not text:
            raise HTTPException(400, "text must be non-empty")
        voice = req.voice or DEFAULT_VOICE

        t0 = time.perf_counter()
        first_chunk_t: float | None = None
        chunks: list = []
        try:
            for _idx, _gs, audio in _pipeline(text, voice=voice):
                if first_chunk_t is None:
                    first_chunk_t = time.perf_counter()
                chunks.append(audio)
        except Exception as e:
            raise HTTPException(500, f"synthesis failed: {e}") from e
        if not chunks:
            raise HTTPException(500, "Kokoro produced no audio")

        full = np.concatenate(chunks)
        # Kokoro outputs at 24 kHz. Wrap as a WAV in-memory.
        buf = io.BytesIO()
        sf.write(buf, full, 24000, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()

        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        first_audio_ms = (
            int((first_chunk_t - t0) * 1000) if first_chunk_t else elapsed_ms
        )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "x-elapsed-ms": str(elapsed_ms),
                "x-first-audio-ms": str(first_audio_ms),
                "x-text-chars": str(len(text)),
                "x-voice": voice,
                "x-sample-rate": "24000",
            },
        )

    print(f"[voice-tts] listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
