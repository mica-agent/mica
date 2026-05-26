#!/usr/bin/env bash
# mica-compose.sh — quickstart wrapper around docker-compose.
#
# Front-loads named pre-flight checks so the common failure modes (no GPU
# passthrough, port conflict, low disk) surface as one-line errors with
# remedies BEFORE compose starts pulling 30 GB of model weights.
#
# TWO topologies, one wrapper:
#
#   Default (vLLM, 2-container):  `./scripts/mica-compose.sh up`
#     mica + mica-vllm sibling. vLLM serves Qwen3.6 NVFP4 with continuous
#     batching, shared between voice and chat. ~30 GB model download.
#
#   llama (1-container):          `./scripts/mica-compose.sh up --llama`
#     Just mica. llama-server spawns inside the container on first chat.
#     Smaller footprint, simpler ops, slower. ~22 GB Q4 GGUF on first
#     chat dispatch.
#
# The `--llama` flag switches topology by:
#   - skipping the `--profile vllm` flag (so mica-vllm is filtered out)
#   - exporting MICA_DISABLE_LLAMA=0 and LLAMA_URL=http://127.0.0.1:8012
#     so the `mica` service spawns llama-server in-container
#
# Subcommands:
#   up        Pre-flight, then `docker compose up`. Default. `--llama` toggles topology.
#   doctor    Pre-flight only. Print pass/fail per check, exit non-zero on fail.
#   status    Show service state + URLs.
#   stop      `docker compose down` (preserves volumes; stops all profiles).
#   nuke      `docker compose down -v` (deletes volumes — confirms first).
#   logs      `docker compose logs -f` (tail all services).
#   help      Show this text.
#
# Env overrides:
#   MICA_SKIP_PREFLIGHT=1   Skip all checks. Use in CI or when you know.
#   MICA_SKIP_TAVILY=1      Bypass the Tavily-key preflight (agent web
#                           search will be disabled). Get a free key
#                           at https://app.tavily.com.
#   MICA_AUTO_BUILD=1       Stale-image rebuild policy: silent yes. Auto-add
#                           --build whenever the image is missing or older
#                           than tracked source. Use in CI.
#   MICA_SKIP_REBUILD=1     Stale-image rebuild policy: silent no. Suppress
#                           the interactive prompt and proceed without
#                           rebuilding. Use in CI when you intentionally
#                           don't want a rebuild. Without either, an
#                           interactive TTY gets a [Y/n] prompt (default Y);
#                           a non-TTY proceeds without rebuilding.
#   MICA_WORKSPACE=/path    Where projects live on the host. Default
#                           \$HOME/mica-workspace. Deliberately NOT inside
#                           the cloned repo.
#   HF_CACHE_DIR=/path      Bind-mount the host HF cache into both services
#                           instead of using the named volume.
#   MICA_VLLM_IMAGE=...     Override the vLLM image (e.g. a digest pin).
#   MICA_FRONTEND_PORT      Default 5173. Override on port conflict.
#   MICA_PORT               Default 3002. Override on port conflict.
#                           (Legacy MICA_BACKEND_PORT honored as fallback.)
#   MICA_LLAMA_PORT         Default 8012. Bound on the mica container so
#                           llama-topology users can poke llama-server
#                           directly. Harmless port-map in vLLM topology
#                           (nothing listening on the mica side).
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
    # Show count + top-3 substantive commits since the image was built,
    # not just the single most-recent one. The most-recent commit can be
    # a README/lockfile bump that looks dismissable in isolation; the
    # surrounding count + a few more commits give the user enough context
    # to know whether to rebuild (or accept the prompt below in cmd_up).
    local total_commits image_date
    total_commits=$(git rev-list --count HEAD --since="@$image_ts" -- "${watched[@]}" 2>/dev/null || echo 0)
    image_date=$(date -d "$image_iso" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "?")
    warn "mica:latest predates $total_commits commits on watched paths (built $image_date)"
    hint "rebuild: scripts/mica-compose.sh up --build   (or 'docker compose build mica' first)"
    if [ "$total_commits" -gt 0 ]; then
      hint "Recent substantive changes:"
      local line
      while IFS= read -r line; do
        [ -n "$line" ] && hint "  $line"
      done < <(git log --format='%h %s' --since="@$image_ts" -n 3 -- "${watched[@]}" 2>/dev/null)
      if [ "$total_commits" -gt 3 ]; then
        hint "  (and $((total_commits - 3)) more)"
      fi
    fi
    NEEDS_BUILD=1
  else
    pass "mica:latest present and current with tracked source"
  fi
}

check_tavily_key() {
  # Mica's agents rely on Tavily-MCP for web search (qwen-code's built-in
  # web_search was removed in CLI v0.15.2). Without a TAVILY_API_KEY, the
  # `discover-dependency` skill has no search tool and multi-step builds
  # that need to find a library or verify a URL stall. We fail preflight
  # on missing — preferable to letting users discover the issue at the
  # first failing build. MICA_SKIP_TAVILY=1 bypasses with a warn.
  if [ "${MICA_SKIP_TAVILY:-0}" = "1" ]; then
    warn "MICA_SKIP_TAVILY=1 — continuing without Tavily web search (agent web search disabled)"
    return
  fi
  # Compose stack picks TAVILY_API_KEY up via env_file: .env (repo
  # root). Ambient env also works (`TAVILY_API_KEY=tvly-... mica-compose.sh up`).
  if [ -n "${TAVILY_API_KEY:-}" ]; then
    pass "TAVILY_API_KEY set in environment"
    return
  fi
  if [ -f .env ] && grep -qE '^[[:space:]]*TAVILY_API_KEY=tvly-' .env 2>/dev/null; then
    pass "TAVILY_API_KEY present in .env"
    return
  fi
  fail "TAVILY_API_KEY not found in .env or environment"
  hint "get a free key (1k searches/month) at https://app.tavily.com"
  hint "save it:  echo \"TAVILY_API_KEY=tvly-...\" >> .env"
  hint "or set MICA_SKIP_TAVILY=1 to bypass (agent web search will be disabled)"
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
  check_tavily_key
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
  # Parse our flags out of the arg list before forwarding to docker
  # compose. We strip --llama; everything else passes through (so
  # --build, -d, --force-recreate, etc. still work as expected).
  local topology="vllm"
  local filtered=()
  for arg in "$@"; do
    case "$arg" in
      --llama)        topology="llama" ;;
      --vllm)         topology="vllm" ;;   # explicit no-op for symmetry
      *)              filtered+=("$arg") ;;
    esac
  done

  run_preflight

  title "docker compose up"
  local compose_args=()
  if [ "$topology" = "llama" ]; then
    info "Topology: llama (1-container, llama-server inside mica)"
    # Override compose-file defaults so the mica container spawns
    # llama-server in-process and talks to it on localhost.
    export MICA_DISABLE_LLAMA="0"
    export LLAMA_URL="http://127.0.0.1:8012"
  else
    info "Topology: vllm (2-container, mica + mica-vllm sibling)"
    compose_args+=(--profile vllm)
  fi

  # Stale-image handling. Decision table:
  #   --build already passed on cmdline → no-op (already rebuilding)
  #   MICA_AUTO_BUILD=1                  → silent rebuild (CI: yes)
  #   MICA_SKIP_REBUILD=1                → silent skip (CI: no)
  #   interactive TTY                    → prompt, default Yes (catch up)
  #   non-TTY, no overrides              → warn-and-proceed (back-compat)
  if [ "${NEEDS_BUILD:-0}" = "1" ] \
     && ! printf '%s\n' "${filtered[@]}" | grep -qx -- '--build'; then
    if [ "${MICA_AUTO_BUILD:-0}" = "1" ]; then
      info "MICA_AUTO_BUILD=1 — adding --build"
      filtered=("--build" "${filtered[@]}")
    elif [ "${MICA_SKIP_REBUILD:-0}" = "1" ]; then
      info "MICA_SKIP_REBUILD=1 — proceeding without rebuild"
    elif [ -t 0 ] && [ -t 1 ]; then
      printf '\n  %sImage is stale.%s Rebuild now? [Y/n] ' "$C_YLW" "$C_RST"
      local ans=""
      read -r ans || true
      case "${ans,,}" in
        n|no)
          info "skipping rebuild — re-run with --build or MICA_AUTO_BUILD=1 to refresh later"
          ;;
        *)
          info "rebuilding — adding --build"
          filtered=("--build" "${filtered[@]}")
          ;;
      esac
    else
      info "image is stale; pass --build, set MICA_AUTO_BUILD=1, or run in a TTY to accept the rebuild prompt"
    fi
  fi

  # Set expectations BEFORE the long compose-up wait. First-time users hit
  # ~30 GB of model download with no granular feedback (raw container logs
  # aren't stage-shaped) — the banner names the stages so a 10-min wait
  # doesn't feel like a hang.
  print_startup_banner "$topology"

  # Heartbeat watcher: every 30s, print a state snapshot alongside the
  # live compose logs. Stands out from per-line log noise via a bordered
  # multi-line block. Killed by the EXIT trap when compose returns.
  start_progress_watcher "$topology" &
  local watcher_pid=$!
  # shellcheck disable=SC2064
  trap "kill $watcher_pid 2>/dev/null; wait $watcher_pid 2>/dev/null; trap - EXIT INT TERM" EXIT INT TERM

  # NOT exec — we need the trap to fire on compose exit to reap the
  # watcher. Ctrl+C still works (compose handles SIGINT cleanly, then
  # control returns to the trap).
  docker compose "${compose_args[@]}" up "${filtered[@]}"
}

# ── startup-progress messaging ───────────────────────────────────
#
# Pre-banner names the stages first-time setup walks through, so a
# 5-15 min wait on docker pull + 30 GB model download doesn't feel
# like a hang. The watcher heartbeat (next function) then anchors
# the user against wall-clock elapsed time.

print_startup_banner() {
  local topology="$1"
  local first_run="no"
  # Heuristic: missing image OR missing/empty mica-models volume → first
  # run. Doesn't account for partial first runs; that's ok, banner is
  # advisory not authoritative.
  if ! docker image inspect mica:latest >/dev/null 2>&1; then
    first_run="image-missing"
  elif ! docker volume inspect mica_mica-models >/dev/null 2>&1; then
    first_run="weights-missing"
  fi

  printf '\n'
  if [ "$first_run" = "no" ]; then
    printf '  %sWarm restart%s — model weights cached, vLLM should be ready in 30-90s.\n' \
      "$C_BLD" "$C_RST"
    printf '\n'
    return
  fi
  printf '  %sFirst-run startup — expect 5–15 minutes:%s\n' "$C_BLD" "$C_RST"
  local step=1
  if [ "$first_run" = "image-missing" ]; then
    printf '    %d. Pulling Docker image %s(~3 GB)%s\n' "$step" "$C_DIM" "$C_RST"
    step=$((step + 1))
  fi
  if [ "$topology" = "vllm" ]; then
    printf '    %d. Downloading model weights %s(~30 GB NVFP4 — the long stage)%s\n' \
      "$step" "$C_DIM" "$C_RST"
    step=$((step + 1))
    printf '    %d. Warming up vLLM %s(~60s after download finishes)%s\n' \
      "$step" "$C_DIM" "$C_RST"
  else
    printf '    %d. Downloading model weights %s(~22 GB GGUF)%s\n' \
      "$step" "$C_DIM" "$C_RST"
    step=$((step + 1))
    printf '    %d. Warming up llama-server %s(~30s after download finishes)%s\n' \
      "$step" "$C_DIM" "$C_RST"
  fi
  step=$((step + 1))
  printf '    %d. Starting frontend + backend %s(seconds)%s\n' "$step" "$C_DIM" "$C_RST"
  printf '\n'
  printf '  %sProgress heartbeat every 30s. Subsequent runs are seconds.%s\n' "$C_DIM" "$C_RST"
  printf '\n'
}

start_progress_watcher() {
  local topology="$1"
  local start_ts
  start_ts="$(date +%s)"
  # First heartbeat at +30s — gives compose a moment to print its own
  # initial "Pulling X" lines so we don't immediately interleave.
  while sleep 30; do
    local now elapsed_sec elapsed_min elapsed_disp
    now="$(date +%s)"
    elapsed_sec=$((now - start_ts))
    elapsed_min=$((elapsed_sec / 60))
    elapsed_disp="$(printf '%dm%02ds' "$elapsed_min" "$((elapsed_sec % 60))")"

    # Probe each layer. Failures (curl timeout, ps empty) are expected
    # mid-startup; we just want a snapshot.
    local mica_state="" vllm_state="" vllm_ready="no" frontend_ready="no"
    if mica_state="$(docker compose ps --format '{{.Service}}|{{.State}}' 2>/dev/null \
        | awk -F'|' '$1=="mica"{print $2}')"; then :; fi
    if [ "$topology" = "vllm" ]; then
      vllm_state="$(docker compose ps --format '{{.Service}}|{{.State}}' 2>/dev/null \
        | awk -F'|' '$1=="mica-vllm"{print $2}')"
      # vLLM listens on :8000 INSIDE its sibling container; not exposed
      # to the host. Reuse the docker healthcheck status (same
      # `curl /v1/models` probe that compose's `depends_on:
      # condition: service_healthy` reads).
      local vllm_cid
      vllm_cid="$(docker compose ps -q mica-vllm 2>/dev/null)"
      if [ -n "$vllm_cid" ]; then
        local vllm_health
        vllm_health="$(docker inspect "$vllm_cid" --format '{{.State.Health.Status}}' 2>/dev/null)"
        [ "$vllm_health" = "healthy" ] && vllm_ready="yes"
      fi
    fi
    curl -fsS --max-time 2 http://localhost:5173/ >/dev/null 2>&1 \
      && frontend_ready="yes"

    # Bordered multi-line banner stands out from docker's per-line output.
    printf '\n'
    printf '  %s┌─ mica progress: %s elapsed ─────────────────────%s\n' \
      "$C_BLU" "$elapsed_disp" "$C_RST"
    if [ "$topology" = "vllm" ]; then
      _heartbeat_line "vLLM container" "$([ "$vllm_state" = "running" ] && echo ok || echo "${vllm_state:-pending}")"
      _heartbeat_line "vLLM /v1/models ready" "$([ "$vllm_ready" = "yes" ] && echo ok || echo "waiting (model loading)")"
    fi
    _heartbeat_line "Mica container" "$([ "$mica_state" = "running" ] && echo ok || echo "${mica_state:-pending}")"
    _heartbeat_line "Frontend (port 5173)" "$([ "$frontend_ready" = "yes" ] && echo ok || echo "waiting")"
    printf '  %s└─ open http://localhost:5173 once everything is ok ──%s\n' "$C_BLU" "$C_RST"
    printf '\n'
  done
}

_heartbeat_line() {
  local label="$1" status="$2"
  if [ "$status" = "ok" ]; then
    printf '  %s│%s  %s✓%s %-26s %s%s%s\n' \
      "$C_BLU" "$C_RST" "$C_GRN" "$C_RST" "$label" "$C_DIM" "ready" "$C_RST"
  else
    printf '  %s│%s  %s⠿%s %-26s %s%s%s\n' \
      "$C_BLU" "$C_RST" "$C_YLW" "$C_RST" "$label" "$C_DIM" "$status" "$C_RST"
  fi
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
  # mica-vllm is profile-gated (profiles: ["vllm"]) and `docker compose
  # down` without --profile DOESN'T touch services hidden behind a
  # profile gate — they stay Exited rather than being removed.
  # --remove-orphans does NOT cover this case; it only removes containers
  # for services that are no longer in the YAML at all. The next `up`
  # then creates a fresh mica_default network with a new ID, tries to
  # start the orphaned mica-vllm whose HostConfig still references the
  # OLD network ID, and errors with "failed to set up container
  # networking: network <id> not found". The fix is to explicitly pass
  # the profile so down considers mica-vllm part of the active set.
  # If new profiles are added to the compose file, add them here too.
  exec docker compose --profile vllm down --remove-orphans "$@"
}

cmd_nuke() {
  printf '%sThis will delete the mica-models and mica-claude volumes.%s\n' "$C_YLW" "$C_RST"
  printf '%sModels will need to re-download on next 'up'.%s\n' "$C_YLW" "$C_RST"
  read -r -p "Type 'yes' to confirm: " ans
  [ "$ans" = "yes" ] || { echo "aborted"; exit 1; }
  # See cmd_stop for rationale on --profile vllm + --remove-orphans.
  exec docker compose --profile vllm down -v --remove-orphans "$@"
}

cmd_logs() {
  exec docker compose logs -f "$@"
}

cmd_help() {
  cat <<EOF
mica-compose.sh — wrapper around docker-compose with preflight checks.

Usage: scripts/mica-compose.sh <subcommand> [args...]

Subcommands:
  up [--llama]  Run preflight checks, then 'docker compose up'. Default
                topology is vllm (2-container: mica + mica-vllm sibling).
                Pass --llama for the 1-container topology (llama-server
                spawned inside the mica container on first chat).
  doctor        Run preflight checks only. Useful before committing to a model download.
  status        Show running services + URLs.
  stop          'docker compose down' — graceful stop, preserves volumes (all profiles).
  nuke          'docker compose down -v' — also deletes volumes (with confirmation).
  logs          'docker compose logs -f' — tail all service logs.
  help          Show this text.

Environment overrides:
  MICA_SKIP_PREFLIGHT=1     Bypass all checks (CI).
  MICA_SKIP_TAVILY=1        Bypass the Tavily-key check (agent web search
                            will be disabled). Get a free key at
                            https://app.tavily.com.
  MICA_AUTO_BUILD=1         Stale-image rebuild policy: silent yes (CI).
                            Auto-add --build when the image is missing or
                            older than tracked source.
  MICA_SKIP_REBUILD=1       Stale-image rebuild policy: silent no (CI).
                            Suppress the prompt and proceed without rebuild.
                            Without either, a TTY gets [Y/n] (default Y);
                            a non-TTY proceeds without rebuilding.
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
