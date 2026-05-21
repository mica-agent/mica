#!/usr/bin/env bash
# Mica — Docker container lifecycle for an installed Mica.
#
# Wraps the daily start/stop/restart/status/logs operations on the
# container that install.sh creates. Same env-var conventions as
# install.sh, so MICA_WORKSPACE / MICA_IMAGE / MICA_CONTAINER / port
# overrides applied at install time keep working here.
#
# What this script does NOT do:
#   - Pull the image (install.sh owns that — first install only)
#   - Run preflight checks (install.sh owns those)
#   - Manage the auxiliary vLLM container
#
# Usage: bash scripts/mica.sh {start|stop|restart|status|logs|help}

set -euo pipefail

# ── Colors (NO_COLOR + non-TTY safe) ──────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RESET=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# ── Defaults (mirror install.sh) ─────────────────────────────────
# Port env vars match what server/index.ts and vite.config.ts read at
# runtime (MICA_PORT / MICA_FRONTEND_PORT). Legacy MICA_PORT_BACKEND /
# MICA_PORT_FRONTEND / MICA_PORT_LLAMA are honored as fallbacks.
WORKSPACE="${MICA_WORKSPACE:-$HOME/mica-workspace}"
IMAGE="${MICA_IMAGE:-ghcr.io/robchang/mica:latest}"
NAME="${MICA_CONTAINER:-mica}"
PORT_BACKEND="${MICA_PORT:-${MICA_PORT_BACKEND:-3002}}"
PORT_FRONTEND="${MICA_FRONTEND_PORT:-${MICA_PORT_FRONTEND:-5173}}"
PORT_LLAMA="${MICA_LLAMA_PORT:-${MICA_PORT_LLAMA:-8012}}"
VOLUME_MODELS="${MICA_MODEL_VOLUME:-mica-models}"

# ── Tavily key gate ──────────────────────────────────────────────
# Mica's agents rely on Tavily-MCP for web search (qwen-code's
# built-in web_search was removed in CLI v0.15.2). Without a
# TAVILY_API_KEY, the `discover-dependency` skill — which the
# builder-workflow templates lean on — has no search tool, and
# multi-step builds that need to find a library or verify a URL
# stall out. So we treat it as a prerequisite, not an option,
# and prompt at start time if it isn't already set.
#
# Resolution order:
#   1. $MICA_WORKSPACE/.env already has TAVILY_API_KEY=... → done.
#      start.sh inside the container sources $PROJECT_DIR/.env, so
#      this is the persistent home for the key.
#   2. Ambient $TAVILY_API_KEY env var → save it to the .env above
#      so the next start finds it without re-prompting.
#   3. MICA_SKIP_TAVILY=1 → loudly warn and continue. For users who
#      truly can't get a key (org restrictions, offline).
#   4. Otherwise → prompt the user via /dev/tty (works under
#      `curl | bash`), validate the rough shape, save to the .env
#      above.
#
# Get a free key (1k searches/month) at https://app.tavily.com.
ensure_tavily_key() {
  mkdir -p "$WORKSPACE"
  local env_file="$WORKSPACE/.env"
  # Case 1: already in workspace .env.
  if [ -f "$env_file" ] && grep -qE '^[[:space:]]*TAVILY_API_KEY=tvly-' "$env_file" 2>/dev/null; then
    ok "TAVILY_API_KEY present in $env_file"
    return 0
  fi
  # Case 2: ambient env. Save and we're done.
  if [ -n "${TAVILY_API_KEY:-}" ]; then
    printf 'TAVILY_API_KEY=%s\n' "$TAVILY_API_KEY" >> "$env_file"
    ok "TAVILY_API_KEY from environment saved to $env_file"
    return 0
  fi
  # Case 3: explicit opt-out.
  if [ "${MICA_SKIP_TAVILY:-0}" = "1" ]; then
    warn "MICA_SKIP_TAVILY=1 — continuing without Tavily web search"
    warn "  Agents will have no web search; multi-step builds that need to find"
    warn "  libraries or verify URLs may stall. Set TAVILY_API_KEY later in"
    warn "  $env_file and restart to enable."
    return 0
  fi
  # Case 4: prompt.
  say ""
  say "${C_WARN}Tavily API key needed${C_RESET}"
  say ""
  say "Mica's agents use Tavily-MCP for web search. Without a key, the"
  say "agent has no search tool — multi-step builds that need to find"
  say "a library or verify a URL will stall."
  say ""
  say "Get a free key (1k searches/month) at: ${C_DIM}https://app.tavily.com${C_RESET}"
  say "To skip this prompt: re-run with ${C_DIM}MICA_SKIP_TAVILY=1${C_RESET}"
  say ""
  local key=""
  # Read from the controlling tty so `curl | bash` still gets human
  # input rather than consuming script bytes from stdin.
  if [ -r /dev/tty ]; then
    read -r -p "Paste your Tavily key (tvly-...): " key < /dev/tty
  else
    die "no tty available to prompt for TAVILY_API_KEY. Set the env var or use MICA_SKIP_TAVILY=1."
  fi
  # Light shape validation. Tavily keys start with `tvly-`. Don't be
  # strict beyond that — better to accept an unusual one than reject
  # a valid one with a stricter regex.
  case "$key" in
    tvly-*) ;;
    *)
      die "that doesn't look like a Tavily key (expected to start with 'tvly-'). Try again, or use MICA_SKIP_TAVILY=1."
      ;;
  esac
  printf 'TAVILY_API_KEY=%s\n' "$key" >> "$env_file"
  ok "Tavily key saved to $env_file"
}

# ── Helpers ──────────────────────────────────────────────────────
# Returns: "running" | "stopped" | "missing"
container_state() {
  # `docker ps -a --filter name=^X$` returns one line per exact-name match,
  # empty output if no container exists. Avoids the `docker inspect` quirk
  # where missing containers print a stray newline to stdout before failing.
  local raw
  raw="$(docker ps -a --filter "name=^${NAME}$" --format '{{.State}}' 2>/dev/null || true)"
  case "$raw" in
    running) echo "running" ;;
    "")      echo "missing" ;;
    *)       echo "stopped" ;;  # exited / created / paused / dead / restarting
  esac
}

image_present() {
  docker image inspect "$IMAGE" >/dev/null 2>&1
}

print_urls() {
  say ""
  say "  UI:        http://localhost:$PORT_FRONTEND/"
  say "  API:       http://localhost:$PORT_BACKEND/api"
  say "  Workspace: $WORKSPACE"
  say ""
  say "  ${C_DIM}logs:    bash scripts/mica.sh logs${C_RESET}"
  say "  ${C_DIM}stop:    bash scripts/mica.sh stop${C_RESET}"
}

# ── Subcommands ──────────────────────────────────────────────────
cmd_start() {
  local state; state="$(container_state)"
  case "$state" in
    running)
      ok "$NAME is already running"
      print_urls
      ;;
    stopped)
      # Make sure the workspace .env has TAVILY_API_KEY before we
      # bring the container back up. The container's start.sh reads
      # /project/.env on every boot, so any value saved now lands
      # in the agent's env without us having to docker-run with -e.
      ensure_tavily_key
      say "Starting existing container $NAME …"
      docker start "$NAME" >/dev/null
      ok "$NAME started"
      print_urls
      ;;
    missing)
      if ! image_present; then
        die "Image '$IMAGE' is not present locally. Run \`bash install.sh\` first to pull and create the container."
      fi
      mkdir -p "$WORKSPACE"
      # Gate: workspace .env must carry a Tavily key (or user opted
      # out with MICA_SKIP_TAVILY=1) before we create the container.
      ensure_tavily_key
      say "No container named $NAME exists. Creating fresh from $IMAGE …"
      local run_args=(
        --rm -d
        --name "$NAME"
        --gpus all
        -p "$PORT_BACKEND:3002"
        -p "$PORT_FRONTEND:5173"
        -p "$PORT_LLAMA:8012"
        -v "$WORKSPACE:/project"
        -v "$VOLUME_MODELS:/home/vscode/.cache/huggingface"
        # Single-container llama topology — match install.sh. Without this,
        # start.sh tries to nest a vLLM container via docker socket
        # (which we don't bind-mount here). Backend auto-spawns
        # llama-server in this container instead.
        -e MICA_DISABLE_CHAT_VLLM=1
      )
      if [ "${MICA_DISABLE_LLAMA:-0}" = "1" ]; then
        run_args+=( -e MICA_DISABLE_LLAMA=1 )
        ok "llama-server disabled (OpenRouter-only mode)"
      fi
      # HF_TOKEN: same resolution as install.sh — env wins, otherwise
      # source the huggingface-cli token file if present. Skipped if
      # neither is set (downloads work, just rate-limited).
      local hf_token=""
      if [ -n "${HF_TOKEN:-}" ]; then
        hf_token="$HF_TOKEN"
      elif [ -f "$HOME/.cache/huggingface/token" ] && [ -s "$HOME/.cache/huggingface/token" ]; then
        hf_token="$(cat "$HOME/.cache/huggingface/token")"
      fi
      if [ -n "$hf_token" ]; then
        run_args+=( -e "HF_TOKEN=$hf_token" )
      fi
      if [ "${MICA_MOUNT_CLAUDE:-0}" = "1" ]; then
        local claude_dir="${MICA_CLAUDE_DIR:-$HOME/.claude}"
        if [ -d "$claude_dir" ]; then
          run_args+=( -v "$claude_dir:/home/vscode/.claude" )
          ok "mounting $claude_dir for Claude Code cards"
        else
          warn "MICA_MOUNT_CLAUDE=1 but $claude_dir not found — skipping"
        fi
      fi
      local cid; cid="$(docker run "${run_args[@]}" "$IMAGE")"
      ok "$NAME started: ${cid:0:12}"
      print_urls
      ;;
  esac
}

cmd_stop() {
  local state; state="$(container_state)"
  case "$state" in
    running)
      say "Stopping $NAME …"
      docker stop "$NAME" >/dev/null
      ok "$NAME stopped"
      ;;
    stopped)
      ok "$NAME is already stopped (no-op)"
      ;;
    missing)
      ok "no container named $NAME (no-op)"
      ;;
  esac
}

cmd_restart() {
  local state; state="$(container_state)"
  case "$state" in
    running)
      say "Restarting $NAME …"
      docker restart "$NAME" >/dev/null
      ok "$NAME restarted"
      print_urls
      ;;
    *)
      cmd_start
      ;;
  esac
}

cmd_status() {
  local state; state="$(container_state)"
  say "=== Mica container status ==="
  say ""
  case "$state" in
    running)
      local started_at
      started_at="$(docker inspect -f '{{.State.StartedAt}}' "$NAME" 2>/dev/null)"
      say "  Container: ${C_OK}running${C_RESET} ($NAME)"
      say "  Image:     $IMAGE"
      say "  Started:   $started_at"
      print_urls
      ;;
    stopped)
      say "  Container: ${C_WARN}stopped${C_RESET} ($NAME exists but not running)"
      say ""
      say "  ${C_DIM}start:   bash scripts/mica.sh start${C_RESET}"
      ;;
    missing)
      say "  Container: ${C_DIM}not created${C_RESET} ($NAME does not exist)"
      if image_present; then
        say "  Image:     ${C_OK}present${C_RESET} ($IMAGE)"
        say ""
        say "  ${C_DIM}create + start:  bash scripts/mica.sh start${C_RESET}"
      else
        say "  Image:     ${C_WARN}not pulled${C_RESET} ($IMAGE)"
        say ""
        say "  ${C_DIM}pull + create + start:  bash install.sh${C_RESET}"
      fi
      ;;
  esac
}

cmd_logs() {
  local state; state="$(container_state)"
  case "$state" in
    missing) die "no container named $NAME exists. Nothing to tail." ;;
    *)       exec docker logs -f "$NAME" ;;
  esac
}

cmd_help() {
  cat <<EOF
Mica — Docker container lifecycle wrapper

Usage:
  bash scripts/mica.sh start     start (or create + start) the Mica container
  bash scripts/mica.sh stop      stop the Mica container (idempotent)
  bash scripts/mica.sh restart   restart, or start if not running
  bash scripts/mica.sh status    show container state + URLs
  bash scripts/mica.sh logs      tail container logs (Ctrl+C detaches)
  bash scripts/mica.sh help      show this message

Env-var overrides (mirror install.sh):
  MICA_WORKSPACE      host workspace dir   (default: \$HOME/mica-workspace)
  MICA_IMAGE          docker image         (default: ghcr.io/robchang/mica:latest)
  MICA_CONTAINER      container name       (default: mica)
  MICA_PORT           backend host port    (default: 3002)
  MICA_FRONTEND_PORT  frontend host port   (default: 5173)
  MICA_LLAMA_PORT     llama-server port    (default: 8012)
  MICA_DISABLE_LLAMA  set to 1 to skip the local GPU model
  MICA_MOUNT_CLAUDE   set to 1 to bind-mount ~/.claude
  MICA_CLAUDE_DIR     override claude dir  (default: \$HOME/.claude)
  (Legacy MICA_PORT_BACKEND / MICA_PORT_FRONTEND / MICA_PORT_LLAMA names
   still work as fallbacks.)

For the first-time install (image pull + preflight + create), use:
  bash install.sh
EOF
}

# ── Dispatch ─────────────────────────────────────────────────────
# Help is allowed without a working docker; everything else needs it.
case "${1:-help}" in
  help|--help|-h) cmd_help; exit 0 ;;
esac

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

case "${1:-help}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)       die "unknown subcommand '${1:-}'. Try: bash scripts/mica.sh help" ;;
esac
