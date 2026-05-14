#!/usr/bin/env bash
# scripts/lib/vllm-container.sh — shared docker-container helpers.
#
# Sourced by scripts/start.sh (chat vLLM). Provides the common
# docker-run lifecycle:
#
#   vllm_container_check_docker          — fail fast if docker missing
#   vllm_container_image_present <image> — true if image exists locally
#   vllm_container_pull_or_use <image>   — pull or skip for local-only tags
#   vllm_container_status <name>         — print "running" / "exited" / "absent"
#   vllm_container_running <name>        — true if running
#   vllm_container_remove_stopped <name> — rm if not running
#   vllm_container_run_detached \
#     --name N --image I --port HOST:CONT --cid-file F --log-file L \
#     -- <extra docker run args...> -- <command run inside container>
#       Runs container detached, captures cid, streams logs to file in
#       background. Outputs only the cid on success.
#   vllm_container_wait_health <name> <url> <timeout_seconds>
#       Polls health URL with progress nags every 30s; fails fast if
#       the container exits. Returns 0 on first 200, 1 otherwise.
#   vllm_container_stop <name> [<timeout_seconds>]
#       docker stop + docker rm; idempotent.
#
# Conventions:
#   * Caller owns choosing the container name, image, port, vLLM args.
#   * Caller owns the cid/log file paths (commonly under .mica-pids/).
#   * No global state in this lib — every function takes explicit args.
#
# Errors return non-zero; callers `set -euo pipefail` for hard fails.

vllm_container_check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found on PATH." >&2
    echo "If inside the devcontainer, /var/run/docker.sock must be mounted;" >&2
    echo "otherwise run from the host shell." >&2
    return 1
  fi
}

vllm_container_image_present() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1
}

vllm_container_pull_or_use() {
  local image="$1"
  if vllm_container_image_present "$image"; then
    echo "Using local image $image"
  else
    echo "Pulling $image (not found locally)..."
    docker pull "$image"
  fi
}

# Container exists at all (running, stopped, paused, etc.)?
vllm_container_exists() {
  local name="$1"
  docker container inspect "$name" >/dev/null 2>&1
}

# Status string: "running", "exited", "created", etc. — "absent" if no
# such container. Robust against Docker 29.x emitting a blank stdout
# line on inspect-of-nonexistent (which trips the `||` fallback).
vllm_container_status() {
  local name="$1"
  if ! vllm_container_exists "$name"; then
    echo absent
    return 0
  fi
  docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null
}

vllm_container_running() {
  local name="$1"
  vllm_container_exists "$name" || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]
}

vllm_container_remove_stopped() {
  local name="$1"
  vllm_container_exists "$name" || return 0  # nothing to remove
  vllm_container_running "$name" && return 0 # don't touch running
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)"
  echo "Removing stopped container: $name (state: $state)"
  docker rm "$name" >/dev/null
}

# Run a detached container and tail its logs to a host-side log file.
# Args (positional, all required): name, image, port_mapping, cid_file,
# log_file, then `--` then the rest of `docker run` flags (volumes, env,
# etc.), then `--` then the bash -c command run inside the container.
#
# Outputs the container ID on stdout. Returns non-zero on docker run
# failure. The log-streaming background process is detached with disown
# so this function returns immediately.
vllm_container_run_detached() {
  local name image port_map cid_file log_file
  name="$1"; image="$2"; port_map="$3"; cid_file="$4"; log_file="$5"
  shift 5
  # Collect extra docker run args until the first standalone `--`.
  local docker_args=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    docker_args+=("$1")
    shift
  done
  if [ "$1" = "--" ]; then shift; fi
  # The remainder is the bash -c command run inside the container.
  local container_cmd="$*"

  local container_id
  container_id="$(docker run -d \
    --name "$name" \
    -p "$port_map" \
    "${docker_args[@]}" \
    --entrypoint /bin/bash \
    "$image" -c "$container_cmd")" || return 1

  echo "$container_id" > "$cid_file"

  # Stream logs to file in the background; disown so this function
  # returns immediately without holding the shell.
  ( docker logs -f "$name" >"$log_file" 2>&1 ) &
  disown

  echo "$container_id"
}

# Poll health URL until 200 or timeout. Detects container death early.
# Args: container_name, health_url, timeout_seconds.
vllm_container_wait_health() {
  local name="$1"
  local url="$2"
  local timeout="${3:-900}"
  local elapsed=0
  local last_warn=0

  echo "Waiting for $url (timeout ${timeout}s)..."
  while ! curl -sf "$url" >/dev/null 2>&1; do
    local cstate
    cstate="$(vllm_container_status "$name")"
    if [ "$cstate" != "running" ]; then
      echo "Container $name died during startup (state: $cstate). Last 40 log lines:" >&2
      docker logs --tail 40 "$name" 2>&1 >&2 || true
      return 1
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "Health check timed out after ${timeout}s. Container still running; inspect logs." >&2
      return 1
    fi
    if [ $((elapsed - last_warn)) -ge 30 ] && [ "$elapsed" -gt 0 ]; then
      echo "  ...still waiting (${elapsed}s elapsed)"
      last_warn=$elapsed
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "Container $name is healthy."
}

# Stop and remove a container by name. Idempotent — no-op if absent.
# Also kills any background `docker logs -f $name` tail processes
# spawned by vllm_container_run_detached.
vllm_container_stop() {
  local name="$1"
  local timeout="${2:-30}"
  local state
  state="$(vllm_container_status "$name")"
  local stopped=0
  if [ "$state" = "running" ]; then
    echo "Stopping container $name..."
    docker stop --time "$timeout" "$name" >/dev/null
    stopped=1
  fi
  if [ "$state" != "absent" ]; then
    docker rm "$name" >/dev/null 2>&1 || true
  fi
  pkill -f "docker logs -f $name" 2>/dev/null || true
  return 0
}
