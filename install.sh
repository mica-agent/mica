#!/usr/bin/env bash
# Mica — one-line install for DGX Spark.
#
# Released form (curl|bash):
#
#   curl -fsSL https://raw.githubusercontent.com/robchang/mica/mica-lite/install.sh | bash
#
# Also directly invocable from a local checkout: `bash ./install.sh`.
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
#   MICA_PORT=3002                 override backend port mapping
#   MICA_FRONTEND_PORT=5173        override frontend port mapping
#   MICA_LLAMA_PORT=8012           override llama-server port mapping
# (The legacy MICA_PORT_BACKEND / MICA_PORT_FRONTEND / MICA_PORT_LLAMA
# names are still honored as fallbacks for older docs.)

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
# Port env vars: MICA_PORT (backend), MICA_FRONTEND_PORT (frontend),
# MICA_LLAMA_PORT (llama-server inside the container). These names match
# what server/index.ts and vite.config.ts read at runtime, so .env files
# and shell exports work the same across install.sh / mica.sh / start.sh.
# Legacy MICA_PORT_BACKEND / MICA_PORT_FRONTEND / MICA_PORT_LLAMA are
# honored as fallbacks for older docs.
WORKSPACE="${MICA_WORKSPACE:-$HOME/mica-workspace}"
IMAGE="${MICA_IMAGE:-ghcr.io/robchang/mica:latest}"
NAME="${MICA_CONTAINER:-mica}"
PORT_BACKEND="${MICA_PORT:-${MICA_PORT_BACKEND:-3002}}"
PORT_FRONTEND="${MICA_FRONTEND_PORT:-${MICA_PORT_FRONTEND:-5173}}"
PORT_LLAMA="${MICA_LLAMA_PORT:-${MICA_PORT_LLAMA:-8012}}"
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

# ── Tavily API key (required) ──
# Mica's agents rely on Tavily-MCP for web search (qwen-code's
# built-in web_search was removed in CLI v0.15.2). Without a key,
# the `discover-dependency` skill has no search tool, and multi-step
# builds that need to find a library or verify a URL stall. We
# treat it as a prerequisite. Saved to $WORKSPACE/.env so the
# container's start.sh reads it on every boot via /project/.env.
#
# Resolution: ambient $TAVILY_API_KEY → save to .env; else prompt;
# else MICA_SKIP_TAVILY=1 to bypass loudly.
ensure_tavily_key() {
  mkdir -p "$WORKSPACE"
  local env_file="$WORKSPACE/.env"
  if [ -f "$env_file" ] && grep -qE '^[[:space:]]*TAVILY_API_KEY=tvly-' "$env_file" 2>/dev/null; then
    ok "TAVILY_API_KEY present in $env_file"
    return 0
  fi
  if [ -n "${TAVILY_API_KEY:-}" ]; then
    printf 'TAVILY_API_KEY=%s\n' "$TAVILY_API_KEY" >> "$env_file"
    ok "TAVILY_API_KEY from environment saved to $env_file"
    return 0
  fi
  if [ "${MICA_SKIP_TAVILY:-0}" = "1" ]; then
    warn "MICA_SKIP_TAVILY=1 — continuing without Tavily web search"
    warn "  Set TAVILY_API_KEY later in $env_file and restart to enable."
    return 0
  fi
  say ""
  say "${C_WARN}Tavily API key needed${C_RESET}"
  say ""
  say "Mica's agents use Tavily-MCP for web search. Without a key, the"
  say "agent has no search tool — multi-step builds will stall."
  say ""
  say "Get a free key (1k searches/month) at: ${C_DIM}https://app.tavily.com${C_RESET}"
  say "To skip: re-run with ${C_DIM}MICA_SKIP_TAVILY=1${C_RESET}"
  say ""
  local key=""
  if [ -r /dev/tty ]; then
    read -r -p "Paste your Tavily key (tvly-...): " key < /dev/tty
  else
    die "no tty available to prompt for TAVILY_API_KEY. Set the env var or use MICA_SKIP_TAVILY=1."
  fi
  case "$key" in
    tvly-*) ;;
    *) die "that doesn't look like a Tavily key (expected to start with 'tvly-'). Try again, or use MICA_SKIP_TAVILY=1." ;;
  esac
  printf 'TAVILY_API_KEY=%s\n' "$key" >> "$env_file"
  ok "Tavily key saved to $env_file"
}
ensure_tavily_key

# ── HuggingFace token (recommended) ──
# The first chat dispatch downloads ~22 GB of GGUF weights from HF Hub.
# Unauthenticated requests hit rate limits; the HF CLI's saved token at
# ~/.cache/huggingface/token (from `huggingface-cli login`) is the
# easiest source. If neither is set, downloads still work — just
# slower.
HF_TOKEN_RESOLVED=""
if [ -n "${HF_TOKEN:-}" ]; then
  HF_TOKEN_RESOLVED="$HF_TOKEN"
  ok "HF_TOKEN set in environment"
elif [ -f "$HOME/.cache/huggingface/token" ] && [ -s "$HOME/.cache/huggingface/token" ]; then
  HF_TOKEN_RESOLVED="$(cat "$HOME/.cache/huggingface/token")"
  ok "HF_TOKEN read from ~/.cache/huggingface/token"
else
  warn "HF_TOKEN not set (rate limits apply for the first ~22 GB download)"
  warn "  authenticate with: huggingface-cli login   then re-run this script"
  warn "  (public models still work without — just throttled)"
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
  # Single-container llama topology. start.sh's default chat backend is the
  # vllm-container.sh helper, which `docker run`s a sibling vLLM image
  # — that requires a Docker socket bind-mount we deliberately don't
  # do here. Tell start.sh to skip that helper; the backend will
  # auto-spawn llama-server (inside this container) on first chat.
  -e MICA_DISABLE_CHAT_VLLM=1
)

if [ "${MICA_DISABLE_LLAMA:-0}" = "1" ]; then
  RUN_ARGS+=( -e MICA_DISABLE_LLAMA=1 )
  ok "llama-server disabled (OpenRouter-only mode)"
fi

if [ -n "$HF_TOKEN_RESOLVED" ]; then
  RUN_ARGS+=( -e "HF_TOKEN=$HF_TOKEN_RESOLVED" )
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
