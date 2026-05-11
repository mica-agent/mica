#!/usr/bin/env bash
# Backwards-compatible wrapper. Use `voices.sh start qwen-omni` directly.
exec bash "$(dirname "$0")/voices.sh" start qwen-omni "$@"
