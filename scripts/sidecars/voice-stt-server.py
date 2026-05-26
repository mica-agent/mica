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
# NOTE: don't add `from __future__ import annotations` here. FastAPI's
# Pydantic integration can't resolve UploadFile through the resulting
# ForwardRef wrapper and 500s on every request with PydanticUserError.

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

# librosa decodes wav/flac via soundfile but anything else (webm/opus from
# MediaRecorder, m4a, etc.) hands off to audioread which shells out to
# `ffmpeg` on PATH. Prefer system ffmpeg (apt-installed via Dockerfile) —
# fall back to the imageio-ffmpeg-bundled binary if missing. This block
# is a no-op when system ffmpeg is on PATH and imageio-ffmpeg isn't
# installed; it patches PATH + ensures a bare-name symlink when the
# bundled binary IS present but the venv was built in a different
# mount point (devcontainer /workspaces vs production /opt/mica) so the
# symlink target stays valid across environments.
try:
    import imageio_ffmpeg  # type: ignore
    _ff = imageio_ffmpeg.get_ffmpeg_exe()
    _ff_dir = os.path.dirname(_ff)
    if _ff_dir not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = _ff_dir + os.pathsep + os.environ.get("PATH", "")
    # audioread shells out to a bare `ffmpeg`, but the bundled binary is
    # named e.g. ffmpeg-linux-aarch64-v7.0.2 — point a bare-name symlink
    # at it. Use a RELATIVE target so the symlink survives moves between
    # mount points (a venv built inside the devcontainer at
    # /workspaces/mica/... otherwise bakes an absolute path that dangles
    # in the production container at /opt/mica/...). Repair the link if
    # it's already there but pointing at a stale absolute path.
    _link = os.path.join(_ff_dir, "ffmpeg")
    _target = os.path.basename(_ff)  # relative — robust across mount points
    try:
        if os.path.islink(_link):
            if os.readlink(_link) != _target:
                os.unlink(_link)
                os.symlink(_target, _link)
        elif not os.path.exists(_link):
            os.symlink(_target, _link)
        # else: real file (not a link) at that path — leave alone.
    except OSError:
        pass
except ImportError:
    pass

DEFAULT_PORT = int(os.environ.get("VOICE_STT_PORT", "8013"))
DEFAULT_HOST = os.environ.get("VOICE_STT_HOST", "127.0.0.1")

_model = None  # type: ignore
_vad = None  # Silero VAD model — speech-activity detection before Parakeet


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


def load_vad():
    """Load Silero VAD once, lazily, and cache. Cheap: ~1MB, ~0.5s load."""
    global _vad
    if _vad is not None:
        return _vad
    from silero_vad import load_silero_vad  # type: ignore
    print("[voice-stt] loading Silero VAD ...", flush=True)
    t0 = time.perf_counter()
    _vad = load_silero_vad()
    print(f"[voice-stt] Silero VAD loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    return _vad


@asynccontextmanager
async def lifespan(app):
    # Both models on startup so /health latency reflects readiness.
    load_model()
    load_vad()
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
                # audioread sometimes raises with no message — include the
                # exception type so we can tell "no decoder backend" from
                # "corrupt file" from a real codec failure.
                raise HTTPException(
                    400,
                    f"failed to decode audio: {type(e).__name__}: {e or '(no message)'}",
                ) from e
            # Strip non-speech regions with Silero VAD before Parakeet sees
            # the audio. The .voice card's recorder runs continuously while
            # the mic is on, so each upload carries leading + trailing
            # silence (and possibly mid-utterance gaps). Parakeet
            # hallucinates words to "fill" long unusual silences — the
            # source of the "invented lead-in text" complaint. Silero
            # detects voice-activity windows precisely (default 30ms
            # padding around each segment) and we feed only those to
            # Parakeet. Mid-utterance gaps shorter than 100ms get merged
            # automatically; longer gaps just collapse cleanly.
            #
            # Falls back to the untrimmed signal if VAD errors out (model
            # not loaded, torch issue, etc.) — better to feed Parakeet a
            # noisy clip than nothing.
            duration = len(wave) / 16000  # original duration for metrics
            print(
                f"[voice-stt] decoded {duration:.2f}s of 16kHz mono "
                f"(suffix={suffix}, content_type={audio.content_type}, "
                f"upload_bytes={len(content)}, samples={len(wave)})",
                flush=True,
            )
            try:
                import torch  # type: ignore
                import numpy as np  # type: ignore
                from silero_vad import get_speech_timestamps  # type: ignore
                vad = load_vad()
                wave_t = torch.from_numpy(wave)
                speech_segments = get_speech_timestamps(
                    wave_t, vad, sampling_rate=16000,
                )
                if not speech_segments:
                    # Audio is entirely non-speech — return empty transcript.
                    print(
                        f"[voice-stt] VAD: 0 segments (no speech detected) — "
                        f"input was {duration:.2f}s, suffix={suffix}, content_type={audio.content_type}",
                        flush=True,
                    )
                    elapsed_ms = int((time.perf_counter() - t0) * 1000)
                    return {
                        "text": "",
                        "duration_s": duration,
                        "elapsed_ms": elapsed_ms,
                    }
                voice_chunks = [
                    wave[s["start"]:s["end"]] for s in speech_segments
                ]
                wave = np.concatenate(voice_chunks).astype(np.float32)
                duration = len(wave) / 16000  # post-VAD duration
                print(
                    f"[voice-stt] VAD: {len(speech_segments)} segments, "
                    f"{duration:.2f}s of speech kept",
                    flush=True,
                )
            except Exception as e:
                print(f"[voice-stt] VAD failed, using untrimmed: {type(e).__name__}: {e}", flush=True)

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
