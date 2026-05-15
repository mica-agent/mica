#!/usr/bin/env bash
# Voice-stack benchmark — one-time install.
#
# Creates a Python venv at scripts/benchmarks/voice/.venv, installs the
# Parakeet (NeMo) + Kokoro toolchains, downloads the model weights via
# their respective registry pulls, and stages 3 sample audio clips for
# the STT benchmark.
#
# Idempotent: re-running just verifies state (venv present, models
# cached, audio present); ~30s on subsequent runs.

set -euo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RESET=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
AUDIO="$HERE/audio"

# ── Python venv ──────────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
  say "Creating venv at $VENV ..."
  command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH"
  python3 -m venv "$VENV"
  ok "venv created"
else
  ok "venv exists"
fi

# Activate venv via subshell-friendly source for the rest of the script.
# shellcheck source=/dev/null
. "$VENV/bin/activate"

# ── Pip deps ─────────────────────────────────────────────────────
# nvidia-nemo-toolkit covers Parakeet (the ASR pipeline). kokoro is
# the TTS package. librosa+soundfile handle audio I/O. requests for
# the llama-server HTTP probes. psutil for memory measurement.
#
# Pinned versions are intentional — these benchmarks should be
# reproducible. Bump as needed but document the change.
say "Upgrading pip + installing deps (this may take 2–5 min on first run) ..."
python -m pip install --upgrade pip setuptools wheel >/dev/null

# Two install groups so failures are easier to attribute.
python -m pip install \
  "nemo_toolkit[asr]>=2.0,<3.0" \
  "kokoro>=0.7" \
  "soundfile>=0.12" \
  "librosa>=0.10" \
  "requests>=2.31" \
  "psutil>=5.9" \
  "numpy<2.0" \
  "fastapi>=0.110" \
  "uvicorn[standard]>=0.27" \
  "python-multipart>=0.0.9" \
  "imageio-ffmpeg>=0.5" \
  "silero-vad>=5.1" || die "pip install failed — see error above"

# ── Pin cuDNN to match the SYSTEM's installed major.minor ────────
# The 26.04 devcontainer ships system cuDNN at /usr/lib/aarch64-linux-gnu/.
# Some sublibraries (libcudnn_engines_tensor_ir.so.9 in particular) are
# loaded via dlopen from system paths even when torch's bundled cuDNN is
# present in the venv. If the venv's cuDNN MAJOR.MINOR doesn't match the
# system's, mixed-version sublibs load and CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH
# crashes synthesis at runtime (Kokoro/Parakeet GPU init).
#
# Detect the system cuDNN's MAJOR.MINOR from its real-file symlink and
# install a matching nvidia-cudnn-cu13. Torch's static "==9.20.0.48"
# pin warning is informational; cuDNN ABI-compat across patch and minor
# means the install works at runtime.
SYS_CUDNN_MM=""
for d in /usr/lib/aarch64-linux-gnu /usr/lib/x86_64-linux-gnu /usr/lib; do
  if [ -e "$d/libcudnn.so" ]; then
    real=$(readlink -f "$d/libcudnn.so")
    SYS_CUDNN_MM=$(echo "$real" | grep -oE '[0-9]+\.[0-9]+' | head -1)
    break
  fi
done
if [ -n "$SYS_CUDNN_MM" ]; then
  say "Aligning nvidia-cudnn-cu13 to system cuDNN $SYS_CUDNN_MM ..."
  python -m pip install --quiet --force-reinstall \
    "nvidia-cudnn-cu13>=$SYS_CUDNN_MM,<$(echo $SYS_CUDNN_MM | awk -F. '{print $1"."$2+1}')" \
    || warn "cuDNN pin failed — TTS/STT may hit SUBLIBRARY_VERSION_MISMATCH at runtime"
  python -c "import torch; assert torch.backends.cudnn.is_available(), 'cuDNN not available'; print('cuDNN check: OK')" \
    || warn "torch.backends.cudnn.is_available() returned false — runtime TTS/STT will fail"
else
  warn "Could not find system cuDNN at /usr/lib/{aarch64,x86_64,}-linux-gnu; skipping pin"
fi

ok "Python deps installed"

# ── Sample audio ─────────────────────────────────────────────────
# Three clips of clean speech for the STT benchmark. We download from
# the Mozilla Common Voice corpus mirrors via HuggingFace's CDN. If
# these specific URLs go stale, replace with any clean-speech samples
# of the listed durations (5s, 10s, 30s).
mkdir -p "$AUDIO"

# A small Python helper to fetch — avoids depending on curl/wget for
# binary downloads and gives clean error messages.
# The heredoc runs as a python3 subprocess, so it doesn't inherit
# non-exported shell vars. Pass AUDIO + HERE explicitly into its env;
# the script body reads them via os.environ.
AUDIO="$AUDIO" HERE="$HERE" python3 - <<'PY'
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent if "__file__" in dir() else Path(os.environ.get("HERE", "."))
audio = Path(os.environ["AUDIO"])

# Three clips selected from LibriSpeech test-clean (CC-BY 4.0) hosted
# at huggingface.co/datasets/openslr/librispeech_asr — these specific
# URLs reach the audio files directly. If any fail, the benchmark
# scripts will report which clip is missing and skip it.
clips = {
    "clip_5s.wav": "https://huggingface.co/datasets/openslr/librispeech_asr/resolve/main/test-clean/1089/134686/1089-134686-0001.flac",
    "clip_10s.wav": "https://huggingface.co/datasets/openslr/librispeech_asr/resolve/main/test-clean/1089/134686/1089-134686-0002.flac",
    "clip_30s.wav": "https://huggingface.co/datasets/openslr/librispeech_asr/resolve/main/test-clean/1089/134686/1089-134686-0003.flac",
}

# These will be downloaded as .flac and resaved as .wav in the same
# directory. The benchmarks accept either.
for name, url in clips.items():
    flac = audio / name.replace(".wav", ".flac")
    wav = audio / name
    if wav.exists() or flac.exists():
        print(f"  ✓ {name} present")
        continue
    print(f"  ↓ {name} ...", end=" ", flush=True)
    try:
        urllib.request.urlretrieve(url, flac)
        # Convert to wav for broader compatibility.
        try:
            import soundfile as sf  # type: ignore
            data, sr = sf.read(flac)
            sf.write(wav, data, sr)
            flac.unlink()
            print("ok (wav)")
        except Exception:
            print("ok (flac; install soundfile to convert)")
    except Exception as e:
        print(f"FAILED: {e}")
        print(f"    Replace {name} manually with any clean-speech clip of the right duration.")
PY

ok "audio sample bundle staged"

# ── Model weights ────────────────────────────────────────────────
# Parakeet weights pull on first benchmark run via NeMo's HF resolver.
# Same for Kokoro via the kokoro package. Don't pre-download here —
# the bench scripts handle their own resolution and we don't want to
# duplicate that logic.
say ""
ok "install complete"
say ""
say "  Models will be downloaded on first benchmark run:"
say "    - ${C_DIM}nvidia/parakeet-tdt-0.6b-v2${C_RESET} (~1.5 GB, on first bench_parakeet.py run)"
say "    - ${C_DIM}hexgrad/Kokoro-82M${C_RESET}        (~330 MB, on first bench_kokoro.py run)"
say ""
say "  Next: ${C_DIM}bash $HERE/run-all.sh${C_RESET}"
