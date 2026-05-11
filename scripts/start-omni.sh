#!/usr/bin/env bash
# Backwards-compatible wrapper. Use `voices.sh start nemotron` directly.
exec bash "$(dirname "$0")/voices.sh" start nemotron "$@"
