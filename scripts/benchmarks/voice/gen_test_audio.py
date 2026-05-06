#!/usr/bin/env python3
"""gen_test_audio.py — generate the three sample clips Kokoro speaks.

Used as a fallback when the LibriSpeech download in install.sh fails
(HF URLs sometimes shift / require auth). Self-contained; uses the
already-installed Kokoro to synthesize ~5s / ~10s / ~30s of clean
speech. Latency benchmarks don't care that the source is synthetic —
they measure transcription time, not accuracy against ground truth.

Usage:
    python gen_test_audio.py

Writes audio/clip_5s.wav, clip_10s.wav, clip_30s.wav.
"""
from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIO = HERE / "audio"

# Kokoro paces around 150-170 chars/sec at default speed. Pick text
# lengths that produce roughly the target durations.
CLIPS = {
    "clip_5s": (
        "Mica is a canvas where humans and agents work together "
        "on problems."
    ),  # ~70 chars → ~5s
    "clip_10s": (
        "Mica turns your local hardware into a workshop where "
        "agents do real work, including understanding video and "
        "speech, all running locally."
    ),  # ~150 chars → ~10s
    "clip_30s": (
        "When you work with an AI agent today, the agent is where "
        "the context lives. You can see what the agent says but "
        "you cannot see what the agent knows. When the next "
        "session starts, all of that is gone. Mica fixes that for "
        "both sides at once. The canvas is plain files in your "
        "project, editable by you, readable by any agent. You can "
        "see what the agent has been working with, and the agent "
        "sees what you've figured out."
    ),  # ~440 chars → ~30s
}


def main() -> None:
    AUDIO.mkdir(parents=True, exist_ok=True)
    print("[gen_test_audio] loading Kokoro ...", flush=True)
    from kokoro import KPipeline  # type: ignore

    pipeline = KPipeline(lang_code="a")
    voice = "af_bella"

    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    for name, text in CLIPS.items():
        path = AUDIO / f"{name}.wav"
        if path.exists():
            print(f"  {name}.wav already exists — skipping")
            continue
        print(f"  generating {name}.wav ({len(text)} chars) ...", flush=True)
        chunks: list = []
        for _idx, _gs, audio in pipeline(text, voice=voice):
            chunks.append(audio)
        if not chunks:
            print(f"    no audio produced for {name} — Kokoro returned empty")
            continue
        full = np.concatenate(chunks)
        sf.write(path, full, 24000)
        duration = len(full) / 24000
        print(f"    wrote {path}  ({duration:.2f}s, {full.size} samples)")

    print("\n[gen_test_audio] done")
    print(f"  audio/ contents: {sorted(p.name for p in AUDIO.glob('clip_*.wav'))}")


if __name__ == "__main__":
    main()
