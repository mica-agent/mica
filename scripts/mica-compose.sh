#!/usr/bin/env bash
# mica-compose.sh — production quickstart wrapper around docker-compose.
#
# Front-loads named pre-flight checks so the common failure modes (no GPU
# passthrough, port conflict, low disk) surface as one-line errors with
# remedies BEFORE compose starts pulling 30 GB of model weights.
#
# This is the COMPOSE path: two sibling containers (mica + mica-vllm) for
# the production vLLM serving stack. For the single-container llama-cpp
# alternative, use ./install.sh (first run) + bash scripts/mica.sh start
# (subsequent lifecycle).
#
# Subcommands:
#   up        Pre-flight, then `docker compose up`. Default.
#   doctor    Pre-flight only. Print pass/fail per check, exit non-zero on fail.
#   stop      `docker compose down` (preserves volumes).
#   nuke      `docker compose down -v` (deletes volumes — confirms first).
#   logs      `docker compose logs -f` (tail all services).
#   help      Show this text.
#
# Env overrides:
#   MICA_SKIP_PREFLIGHT=1   Skip all checks. Use in CI or when you know.
#   MICA_WORKSPACE=/path    Where projects live on the host. Default
#                           \$HOME/mica-workspace. Deliberately NOT inside
#                           the cloned repo.
#   HF_CACHE_DIR=/path      Bind-mount the host HF cache into both services
#                           instead of using the named volume.
#   MICA_VLLM_IMAGE=...     Override the vLLM image (e.g. a digest pin).
#   MICA_FRONTEND_PORT      Default 5173. Override on port conflict.
#   MICA_BACKEND_PORT       Default 3002. Override on port conflict.
#   USER_UID, USER_GID      Default 1000:1000. Override if host UID differs.

set -euo pipefail

# Resolve to the repo root regardless of where the user invokes the script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"
BACKEND_PORT="${MICA_BACKEND_PORT:-3002}"
MIN_DISK_GB=40

# Default workspace lives at $HOME/mica-workspace (matches install.sh's
# convention) — NOT inside the cloned repo. Override via MICA_WORKSPACE
# env. Resolve once here so doctor + up both see the same value, and so
# we can pre-create the directory with the right ownership before
# docker compose mounts it (Docker would otherwise auto-create it as
# root, blocking the UID 1000 container user from writing).
export MICA_WORKSPACE="${MICA_WORKSPACE:-$HOME/mica-workspace}"

# ── tty-aware color helpers ──────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'
  C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_DIM=""; C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_BLD=""; C_RST=""
fi
pass()  { printf '  %s[PASS]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
fail()  { printf '  %s[FAIL]%s %s\n' "$C_RED" "$C_RST" "$*"; FAILED=1; }
warn()  { printf '  %s[WARN]%s %s\n' "$C_YLW" "$C_RST" "$*"; }
info()  { printf '  %s[INFO]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
hint()  { printf '         %s→ %s%s\n' "$C_DIM" "$*" "$C_RST"; }
title() { printf '\n%s%s%s\n' "$C_BLD" "$*" "$C_RST"; }

# ── pre-flight checks ────────────────────────────────────────────
FAILED=0

check_docker_daemon() {
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker CLI not found"
    hint "install Docker Engine: https://docs.docker.com/engine/install/"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon not reachable"
    hint "sudo systemctl start docker  (or check 'docker ps' from your user)"
    return
  fi
  pass "docker daemon reachable"
}

check_docker_compose_v2() {
  if ! docker compose version >/dev/null 2>&1; then
    fail "docker compose v2 not installed"
    hint "https://docs.docker.com/compose/install/  (v1's 'docker-compose' won't work)"
    return
  fi
  local v
  v="$(docker compose version --short 2>/dev/null || echo unknown)"
  pass "docker compose v2 installed ($v)"
}

check_gpu_visible_to_host() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi not found on host"
    hint "install the NVIDIA driver matching your GPU"
    return
  fi
  local gpu
  if ! gpu="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"; then
    fail "nvidia-smi did not report a GPU"
    hint "check driver: 'nvidia-smi' should list at least one device"
    return
  fi
  [ -z "$gpu" ] && { fail "nvidia-smi reported zero GPUs"; return; }
  pass "GPU visible to host: $gpu"
}

check_gpu_passthrough() {
  # Light-weight passthrough check: try to run nvidia-smi inside a CUDA base
  # image with --gpus all. If it works, nvidia-container-toolkit is wired up.
  if ! docker run --rm --gpus all nvcr.io/nvidia/cuda:13.1.0-base-ubuntu24.04 \
        nvidia-smi -L >/dev/null 2>&1; then
    fail "Docker can't pass through GPU(s) (nvidia-container-toolkit not configured?)"
    hint "sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
    return
  fi
  pass "Docker GPU runtime configured"
}

check_port_free() {
  local port="$1"
  local var_hint="$2"
  if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    local pid
    pid="$(lsof -iTCP:"$port" -sTCP:LISTEN -t | head -n1)"
    fail "port $port already in use (pid $pid)"
    hint "stop the conflicting process, or set $var_hint=<other> before 'mica-compose.sh up'"
    return
  fi
  pass "port $port free"
}

check_disk_space() {
  local root_dir mount free_gb
  root_dir="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  mount="$(df -P "$root_dir" 2>/dev/null | tail -n1 | awk '{print $6}')"
  free_gb="$(df -BG "$root_dir" 2>/dev/null | tail -n1 | awk '{gsub("G","",$4); print $4}')"
  if [ -z "$free_gb" ] || [ "$free_gb" -lt "$MIN_DISK_GB" ]; then
    fail "low disk: ${free_gb:-?} GB free at $mount (need ${MIN_DISK_GB} GB for models)"
    hint "docker system df → see what's eating space; 'docker system prune -a' if comfortable"
    return
  fi
  pass "disk free at $mount: ${free_gb} GB (need ≥ ${MIN_DISK_GB})"
}

check_hf_cache_dir_if_set() {
  if [ -z "${HF_CACHE_DIR:-}" ]; then
    info "HF_CACHE_DIR unset — using named volume 'mica-models'"
    return
  fi
  if [ ! -d "$HF_CACHE_DIR" ]; then
    fail "HF_CACHE_DIR=$HF_CACHE_DIR does not exist or is not a directory"
    hint "either create it ('mkdir -p \$HF_CACHE_DIR') or unset to use the named volume"
    return
  fi
  pass "HF_CACHE_DIR exists ($HF_CACHE_DIR)"
}

check_workspace_dir() {
  # MICA_WORKSPACE is resolved at script top with $HOME/mica-workspace
  # as the fallback. Pre-create it ourselves so Docker doesn't auto-
  # create it as root:root and lock the UID 1000 container out. Idempotent.
  local uid="${USER_UID:-1000}"
  local gid="${USER_GID:-1000}"
  if [ ! -d "$MICA_WORKSPACE" ]; then
    if mkdir -p "$MICA_WORKSPACE" 2>/dev/null; then
      info "created workspace at $MICA_WORKSPACE"
    else
      fail "could not create $MICA_WORKSPACE"
      hint "either pick a path you can write to via MICA_WORKSPACE=/path, or 'sudo mkdir -p $MICA_WORKSPACE && sudo chown $uid:$gid $MICA_WORKSPACE'"
      return
    fi
  fi
  # Permission alignment: the container runs as uid:gid (default 1000:1000).
  # If the workspace dir is owned by someone else, the container will fail
  # to write new projects.
  local owner
  owner="$(stat -c '%u:%g' "$MICA_WORKSPACE" 2>/dev/null || echo unknown)"
  if [ "$owner" = "unknown" ]; then
    warn "could not stat $MICA_WORKSPACE — skipping ownership check"
  elif [ "$owner" = "$uid:$gid" ]; then
    pass "workspace ok ($MICA_WORKSPACE, owner $owner)"
  else
    warn "workspace at $MICA_WORKSPACE is owned by $owner, but container runs as $uid:$gid"
    hint "either: sudo chown -R $uid:$gid $MICA_WORKSPACE  (recursive)"
    hint "or:     USER_UID=\$(id -u) USER_GID=\$(id -g) ./scripts/mica-compose.sh up"
  fi
}

check_image_built() {
  if ! docker image inspect mica:latest >/dev/null 2>&1; then
    warn "mica:latest not built locally — first 'up' will run 'docker compose build' (~5-10 min)"
  else
    pass "mica:latest image present locally"
  fi
}

check_existing_models_volume() {
  if docker volume inspect mica-models >/dev/null 2>&1; then
    info "named volume 'mica-models' already exists — model downloads will reuse it"
  fi
}

run_preflight() {
  title "Mica compose preflight"
  if [ "${MICA_SKIP_PREFLIGHT:-0}" = "1" ]; then
    info "MICA_SKIP_PREFLIGHT=1 — skipping all checks"
    return 0
  fi
  check_docker_daemon
  check_docker_compose_v2
  check_gpu_visible_to_host
  check_gpu_passthrough
  check_port_free "$FRONTEND_PORT" "MICA_FRONTEND_PORT"
  check_port_free "$BACKEND_PORT"  "MICA_BACKEND_PORT"
  check_disk_space
  check_hf_cache_dir_if_set
  check_workspace_dir
  check_image_built
  check_existing_models_volume
  if [ "$FAILED" -eq 1 ]; then
    printf '\n%spreflight failed%s — fix the issues above, or set MICA_SKIP_PREFLIGHT=1 to bypass.\n' \
      "$C_RED" "$C_RST" >&2
    return 1
  fi
  printf '\n%spreflight ok%s — proceeding.\n' "$C_GRN" "$C_RST"
}

# ── subcommands ──────────────────────────────────────────────────
cmd_up() {
  run_preflight
  title "docker compose up"
  exec docker compose up "$@"
}

cmd_doctor() {
  run_preflight
}

cmd_stop() {
  exec docker compose down "$@"
}

cmd_nuke() {
  printf '%sThis will delete the mica-models and mica-claude volumes.%s\n' "$C_YLW" "$C_RST"
  printf '%sModels will need to re-download on next 'up'.%s\n' "$C_YLW" "$C_RST"
  read -r -p "Type 'yes' to confirm: " ans
  [ "$ans" = "yes" ] || { echo "aborted"; exit 1; }
  exec docker compose down -v "$@"
}

cmd_logs() {
  exec docker compose logs -f "$@"
}

cmd_help() {
  cat <<EOF
mica-compose.sh — production-friendly wrapper around docker-compose.

Usage: scripts/mica-compose.sh <subcommand> [args...]

Subcommands:
  up        Run preflight checks, then 'docker compose up'. Default.
  doctor    Run preflight checks only. Useful before committing to a model download.
  stop      'docker compose down' — graceful stop, preserves volumes.
  nuke      'docker compose down -v' — also deletes volumes (with confirmation).
  logs      'docker compose logs -f' — tail all service logs.
  help      Show this text.

Environment overrides:
  MICA_SKIP_PREFLIGHT=1     Bypass all checks (CI).
  MICA_WORKSPACE=/path      Where projects live on the host.
                            Default: \$HOME/mica-workspace (matches install.sh).
                            NOT inside the cloned repo.
  HF_CACHE_DIR=/path        Bind-mount a host HF cache instead of the named volume.
  MICA_VLLM_IMAGE=...       Override the vLLM image (e.g. a digest pin).
  MICA_FRONTEND_PORT        Default 5173.
  MICA_BACKEND_PORT         Default 3002.
  USER_UID, USER_GID        Default 1000:1000.

For the single-container llama-cpp path (no vLLM sibling), see:
  ./install.sh                  — first-time install (preflight + image pull + run)
  bash scripts/mica.sh start    — subsequent lifecycle (start/stop/restart)
EOF
}

# ── dispatch ─────────────────────────────────────────────────────
sub="${1:-up}"
shift || true
case "$sub" in
  up)              cmd_up "$@" ;;
  doctor)          cmd_doctor ;;
  stop|down)       cmd_stop "$@" ;;
  nuke)            cmd_nuke "$@" ;;
  logs)            cmd_logs "$@" ;;
  help|-h|--help)  cmd_help ;;
  *)
    printf '%sunknown subcommand:%s %s\n\n' "$C_RED" "$C_RST" "$sub" >&2
    cmd_help >&2
    exit 1
    ;;
esac
