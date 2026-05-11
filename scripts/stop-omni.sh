#!/usr/bin/env bash
# Backwards-compatible wrapper. Use `voices.sh stop nemotron` directly.
exec bash "$(dirname "$0")/voices.sh" stop nemotron "$@"
