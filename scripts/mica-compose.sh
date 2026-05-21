#!/usr/bin/env bash
# mica-compose.sh — release-friendly quickstart wrapper around docker-compose.
#
# Front-loads named pre-flight checks so the common failure modes (no GPU
# passthrough, port conflict, low disk) surface as one-line errors with
# remedies BEFORE compose starts pulling 30 GB of model weights.
#
# This is the COMPOSE path: two sibling containers (mica + mica-vllm) for
# the release vLLM serving stack. For the single-container llama-cpp
# alternative, use ./install.sh (first run) + bash scripts/mica.sh start
# (subsequent lifecycle).
#
# Subcommands:
#   up        Pre-flight, then `docker compose up`. Default.
#   doctor    Pre-flight only. Print pass/fail per check, exit non-zero on fail.
#   status    Show service state + URLs.
#   stop      `docker compose down` (preserves volumes).
#   nuke      `docker compose down -v` (deletes volumes — confirms first).
#   logs      `docker compose logs -f` (tail all services).
#   help      Show this text.
#
# Env overrides:
#   MICA_SKIP_PREFLIGHT=1   Skip all checks. Use in CI or when you know.
#   MICA_AUTO_BUILD=1       If the image is missing or older than tracked
#                           source files, auto-add --build to 'up'.
#                           Without this, the script only WARNS — you decide
#                           whether to re-invoke with --build.
#   MICA_WORKSPACE=/path    Where projects live on the host. Default
#                           \$HOME/mica-workspace. Deliberately NOT inside
#                           the cloned repo.
#   HF_CACHE_DIR=/path      Bind-mount the host HF cache into both services
#                           instead of using the named volume.
#   MICA_VLLM_IMAGE=...     Override the vLLM image (e.g. a digest pin).
#   MICA_FRONTEND_PORT      Default 5173. Override on port conflict.
#   MICA_PORT               Default 3002. Override on port conflict.
#                           (Legacy MICA_BACKEND_PORT honored as fallback.)
#   USER_UID, USER_GID      Default 1000:1000. Override if host UID differs.

set -euo pipefail

# Resolve to the repo root regardless of where the user invokes the script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FRONTEND_PORT="${MICA_FRONTEND_PORT:-5173}"
# Backend port name standardized on MICA_PORT (matches what server/index.ts
# reads). Legacy MICA_BACKEND_PORT is honored as a fallback so older
# `.env` files and CI configs keep working.
BACKEND_PORT="${MICA_PORT:-${MICA_BACKEND_PORT:-3002}}"
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
    NEEDS_BUILD=1
    return
  fi

  # Image is present. Check whether tracked source has moved since it was
  # built. Watched paths cover everything `COPY . .` bakes into the runtime
  # image; staleness here = the running container won't have your latest
  # frontend bundle, server code, templates, or built artifacts. We compare
  # the image's Created timestamp against the most-recent commit that
  # touched any watched path.
  local image_iso image_ts src_ts
  local watched=(
    Dockerfile
    package.json
    package-lock.json
    server/
    src/
    templates/
    scripts/
    card-classes/
  )
  image_iso="$(docker image inspect mica:latest --format '{{.Created}}' 2>/dev/null || true)"
  image_ts=$(date -d "$image_iso" +%s 2>/dev/null || echo 0)
  src_ts=$(git log -1 --format=%ct -- "${watched[@]}" 2>/dev/null || echo 0)

  if [ "$image_ts" -eq 0 ] || [ "$src_ts" -eq 0 ]; then
    pass "mica:latest image present (freshness check skipped — no git or no timestamp)"
    return
  fi

  if [ "$src_ts" -gt "$image_ts" ]; then
    local stale_commit image_date
    stale_commit=$(git log -1 --format='%h %s' -- "${watched[@]}" 2>/dev/null || echo "(unknown)")
    image_date=$(date -d "$image_iso" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "?")
    warn "mica:latest is older than tracked source (image built $image_date)"
    hint "rebuild: scripts/mica-compose.sh up --build   (or 'docker compose build mica' first)"
    hint "last source touch: $stale_commit"
    NEEDS_BUILD=1
  else
    pass "mica:latest present and current with tracked source"
  fi
}

check_hf_token() {
  # vLLM and HF Hub treat HF_TOKEN as the authenticated path: lifts rate
  # limits on anonymous downloads and is required for gated models. The
  # compose file's env_file directive picks it up from .env if present.
  # The HF CLI ('huggingface-cli login') writes its token to
  # ~/.cache/huggingface/token; we surface that path so a user who already
  # logged in there doesn't have to be told twice.
  if [ -f .env ] && grep -qE '^[[:space:]]*HF_TOKEN=.+' .env 2>/dev/null; then
    pass "HF_TOKEN set in .env"
    return
  fi

  local cli_token_path="$HOME/.cache/huggingface/token"
  if [ -f "$cli_token_path" ] && [ -s "$cli_token_path" ]; then
    warn "HF_TOKEN not in .env, but a token exists at ~/.cache/huggingface/token"
    hint "use it:  echo \"HF_TOKEN=\$(cat $cli_token_path)\" >> .env"
    hint "(public models still work without — first downloads will be throttled)"
    return
  fi

  info "no HF token found (.env or $cli_token_path) — downloads will be unauthenticated"
  hint "authenticate:  huggingface-cli login    then add HF_TOKEN=... to .env"
  hint "(safe to skip — RedHatAI/Qwen3.6-35B-A3B-NVFP4 is public, just rate-limited)"
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
  NEEDS_BUILD=0
  check_docker_daemon
  check_docker_compose_v2
  check_gpu_visible_to_host
  check_gpu_passthrough
  check_port_free "$FRONTEND_PORT" "MICA_FRONTEND_PORT"
  check_port_free "$BACKEND_PORT"  "MICA_PORT"
  check_disk_space
  check_hf_cache_dir_if_set
  check_workspace_dir
  check_image_built
  check_hf_token
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
  # If preflight flagged a stale (or missing) image AND MICA_AUTO_BUILD=1,
  # silently inject --build. Otherwise the user already saw the warning
  # and a remediation hint — leave the decision to them. Avoid duplicating
  # --build if they already passed it on the command line.
  local args=("$@")
  if [ "${NEEDS_BUILD:-0}" = "1" ] \
     && [ "${MICA_AUTO_BUILD:-0}" = "1" ] \
     && ! printf '%s\n' "${args[@]}" | grep -qx -- '--build'; then
    info "MICA_AUTO_BUILD=1 and image is stale — adding --build"
    args=("--build" "${args[@]}")
  fi
  exec docker compose up "${args[@]}"
}

cmd_doctor() {
  run_preflight
}

cmd_status() {
  # Show compose-stack state + URLs. Lighter-weight than docker compose ps
  # because we don't want to require the user to remember which file is
  # the compose project root. `--format json` keeps the parse stable
  # across docker compose versions.
  title "Mica compose status"
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker not on PATH"
    return 1
  fi
  if ! docker compose ps --format '{{.Service}}|{{.State}}|{{.Status}}' >/tmp/mica-compose-ps.$$ 2>/dev/null; then
    fail "docker compose ps failed — is the compose stack initialized in this directory?"
    rm -f /tmp/mica-compose-ps.$$
    return 1
  fi
  if [ ! -s /tmp/mica-compose-ps.$$ ]; then
    info "no services running"
    info "(run 'scripts/mica-compose.sh up' to start)"
    rm -f /tmp/mica-compose-ps.$$
    return 0
  fi
  printf '\n  %-12s  %-10s  %s\n' "SERVICE" "STATE" "STATUS"
  printf '  %-12s  %-10s  %s\n'   "-------" "-----" "------"
  while IFS='|' read -r svc state status; do
    printf '  %-12s  %-10s  %s\n' "$svc" "$state" "$status"
  done < /tmp/mica-compose-ps.$$
  rm -f /tmp/mica-compose-ps.$$
  echo
  echo "  UI:  http://localhost:$FRONTEND_PORT/"
  echo "  API: http://localhost:$BACKEND_PORT/api"
  echo
  echo "  ${C_DIM}logs:  scripts/mica-compose.sh logs${C_RESET}"
  echo "  ${C_DIM}stop:  scripts/mica-compose.sh stop${C_RESET}"
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
mica-compose.sh — release-friendly wrapper around docker-compose.

Usage: scripts/mica-compose.sh <subcommand> [args...]

Subcommands:
  up        Run preflight checks, then 'docker compose up'. Default.
  doctor    Run preflight checks only. Useful before committing to a model download.
  status    Show running services + URLs.
  stop      'docker compose down' — graceful stop, preserves volumes.
  nuke      'docker compose down -v' — also deletes volumes (with confirmation).
  logs      'docker compose logs -f' — tail all service logs.
  help      Show this text.

Environment overrides:
  MICA_SKIP_PREFLIGHT=1     Bypass all checks (CI).
  MICA_AUTO_BUILD=1         Auto-add --build when the image is stale or missing.
                            Without this, the script only WARNS.
  MICA_WORKSPACE=/path      Where projects live on the host.
                            Default: \$HOME/mica-workspace (matches install.sh).
                            NOT inside the cloned repo.
  HF_CACHE_DIR=/path        Bind-mount a host HF cache instead of the named volume.
  MICA_VLLM_IMAGE=...       Override the vLLM image (e.g. a digest pin).
  MICA_FRONTEND_PORT        Default 5173.
  MICA_PORT                 Default 3002 (backend; matches what server reads).
                            Legacy MICA_BACKEND_PORT honored as fallback.
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
  status|ps)       cmd_status ;;
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
