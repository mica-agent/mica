#!/usr/bin/env bash
# Mica — one-line install for DGX Spark.
#
# Typical usage (from the README):
#
#   curl -fsSL https://raw.githubusercontent.com/robchang/mica/mica-lite/install.sh | bash
#
# This script:
#   1. Preflight-checks the host (docker + NVIDIA Container Toolkit + arm64).
#   2. Creates the workspace dir with the right ownership so the
#      UID 1000 container user can write to it.
#   3. Pulls the Mica image from GHCR with visible progress.
#   4. Starts Mica detached; prints the URL and stop command.
#
# Tweaks — prepend any of these env vars to the curl line:
#   MICA_WORKSPACE=/data/my-mica   alternate host workspace dir
#   MICA_IMAGE=ghcr.io/...:0.1.0   pin to a specific image tag
#   MICA_DISABLE_LLAMA=1           skip llama-server (OpenRouter-only)
#   MICA_MOUNT_CLAUDE=1            bind-mount ~/.claude for Claude Code cards
#   MICA_PORT_BACKEND=3002         override port mappings
#   MICA_PORT_FRONTEND=5173
#   MICA_PORT_LLAMA=8012

set -euo pipefail

# ── ANSI colours for friendly output. Respects NO_COLOR / non-TTY. ──
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RESET=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# ── Tweakable defaults (env-var overrides above). ──
WORKSPACE="${MICA_WORKSPACE:-$HOME/mica-workspace}"
IMAGE="${MICA_IMAGE:-ghcr.io/robchang/mica:latest}"
NAME="${MICA_CONTAINER:-mica}"
PORT_BACKEND="${MICA_PORT_BACKEND:-3002}"
PORT_FRONTEND="${MICA_PORT_FRONTEND:-5173}"
PORT_LLAMA="${MICA_PORT_LLAMA:-8012}"
VOLUME_MODELS="${MICA_MODEL_VOLUME:-mica-models}"

# ── Preflight: docker + NVIDIA Container Toolkit + arch ──
say "${C_DIM}Mica install for DGX Spark${C_RESET}"
say ""

command -v docker >/dev/null 2>&1 \
  || die "docker not found. Install Docker first: https://docs.docker.com/engine/install/"
ok "docker found"

if ! docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia\|nvidia-container'; then
  warn "NVIDIA Container Toolkit not detected in 'docker info'."
  warn "The container will fail to see the GPU without it."
  warn "Install guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  say  ""
else
  ok "NVIDIA Container Toolkit present"
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  warn "Host arch is '$ARCH' — this image is built for arm64 (DGX Spark)."
  warn "It may still run via emulation, but performance will be poor."
  say  ""
else
  ok "arm64 host"
fi

# ── Workspace directory ──
# Docker will auto-create a missing bind-mount target as root, then the
# UID 1000 container user can't write to it. Pre-creating with mkdir -p
# and chowning (when possible) avoids that whole class of bug.
if [ ! -d "$WORKSPACE" ]; then
  say "Creating workspace directory: $WORKSPACE"
  mkdir -p "$WORKSPACE"
  ok "workspace directory created"
else
  ok "workspace directory exists: $WORKSPACE"
fi

# Chown to the host user so the container's UID 1000 matches when the
# host user is also UID 1000 (typical on Ubuntu / DGX Spark). If host
# user is a different UID, they can chown afterward.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
if [ "$HOST_UID" = "1000" ]; then
  ok "host user is UID 1000 (matches container)"
else
  warn "host UID is $HOST_UID — container runs as UID 1000. If you see"
  warn "permission errors writing to $WORKSPACE, run:"
  warn "    sudo chown -R 1000:1000 $WORKSPACE"
fi

# ── Image pull (explicit so user sees progress) ──
say ""
say "Pulling $IMAGE (first run downloads ~10 GB) …"
docker pull "$IMAGE" || die "docker pull failed. Is the image public and your network up?"
ok "image pulled"

# ── Run ──
# Remove any existing container with the same name so re-running the
# installer gives a clean container rather than "container name taken".
docker rm -f "$NAME" >/dev/null 2>&1 || true

RUN_ARGS=(
  --rm
  -d
  --name "$NAME"
  --gpus all
  -p "$PORT_BACKEND:3002"
  -p "$PORT_FRONTEND:5173"
  -p "$PORT_LLAMA:8012"
  -v "$WORKSPACE:/project"
  -v "$VOLUME_MODELS:/home/vscode/.cache/huggingface"
)

if [ "${MICA_DISABLE_LLAMA:-0}" = "1" ]; then
  RUN_ARGS+=( -e MICA_DISABLE_LLAMA=1 )
  ok "llama-server disabled (OpenRouter-only mode)"
fi

if [ "${MICA_MOUNT_CLAUDE:-0}" = "1" ]; then
  CLAUDE_DIR="${MICA_CLAUDE_DIR:-$HOME/.claude}"
  if [ -d "$CLAUDE_DIR" ]; then
    RUN_ARGS+=( -v "$CLAUDE_DIR:/home/vscode/.claude" )
    ok "mounting $CLAUDE_DIR for Claude Code cards"
  else
    warn "MICA_MOUNT_CLAUDE=1 set but $CLAUDE_DIR not found — skipping"
  fi
fi

say ""
say "Starting Mica …"
CONTAINER_ID="$(docker run "${RUN_ARGS[@]}" "$IMAGE")"
ok "container started: ${CONTAINER_ID:0:12}"

# ── Friendly output ──
say ""
say "${C_OK}Mica is running.${C_RESET}"
say ""
say "  UI:        http://localhost:$PORT_FRONTEND/"
say "  API:       http://localhost:$PORT_BACKEND/api"
say "  Workspace: $WORKSPACE"
say ""
say "  View logs: ${C_DIM}docker logs -f $NAME${C_RESET}"
say "  Stop:      ${C_DIM}docker stop $NAME${C_RESET}"
say ""
if [ "${MICA_DISABLE_LLAMA:-0}" != "1" ]; then
  say "${C_DIM}First run downloads the default model (Qwen3.6-35B, ~22 GB)"
  say "on the first chat request. Subsequent runs start in seconds.${C_RESET}"
fi
