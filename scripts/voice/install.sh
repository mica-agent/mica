#!/usr/bin/env bash
# Voice sidecar runtime — venv setup for Parakeet (STT) + Kokoro (TTS).
#
# Mica's voice path spawns two Python sidecars lazily on first voice
# request:
#   voice-stt  (Parakeet-TDT-0.6b-v2)  → 127.0.0.1:8013/transcribe
#   voice-tts  (Kokoro-82M)            → 127.0.0.1:8014/synthesize
#
# Both sidecars import torch/transformers/etc. — a heavyweight stack
# that doesn't belong in the base Node container. This script creates
# a dedicated Python venv at scripts/voice/.venv and installs every
# dependency the sidecars need (Parakeet via nvidia-nemo-toolkit, Kokoro,
# fastapi/uvicorn for the HTTP surface, librosa/soundfile for audio I/O,
# silero-vad for the voice card's VAD).
#
# Run once per workspace, on:
#   - devcontainer first boot (manually)
#   - Dockerfile build (automatically; see Dockerfile near `bash scripts/voice/install.sh`)
#
# Idempotent: re-running just verifies state (venv present, deps
# installed); ~30s on subsequent runs. Bumping a pin re-installs only
# that package.
#
# This is the file that VOICE_VENV_PYTHON in server/voiceServers.ts and
# server/cardSidecar.ts expect. If you move the venv, update those refs.

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
# the TTS package. librosa+soundfile handle audio I/O. fastapi+uvicorn
# expose the sidecar HTTP surface. silero-vad gates the voice card's
# capture pipeline (start-of-speech / end-of-speech detection).
#
# Pinned versions are intentional — release sidecars need
# reproducible behavior. Bump as needed but verify both sidecars still
# start cleanly after the change.
say "Upgrading pip + installing deps (this may take 2–5 min on first run) ..."
python -m pip install --upgrade pip setuptools wheel >/dev/null

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

# ── Done ─────────────────────────────────────────────────────────
# Model weights pull lazily on FIRST sidecar request, not here:
#   - nvidia/parakeet-tdt-0.6b-v2  (~1.5 GB, on first STT request)
#   - hexgrad/Kokoro-82M           (~330 MB, on first TTS request)
# Both cache under $HF_HOME (default: ~/.cache/huggingface) so the
# weight pull happens once per workspace.
say ""
ok "install complete"
say ""
say "  Mica will spawn the sidecars on first voice request — no manual start needed."
say "  Weight downloads happen on that first request (~10s STT, ~2s TTS warm)."
