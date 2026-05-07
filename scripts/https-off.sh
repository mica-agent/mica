#!/usr/bin/env bash
# https-off.sh — tear down the Tailscale Serve HTTPS proxy.
#
# Run on the SPARK HOST, same as https-on.sh. Doesn't touch the
# devcontainer or Mica's processes — just removes the host-side
# Tailscale proxy that was fronting Vite's port over HTTPS.
#
# Note: `tailscale serve reset` clears ALL serve configs on this
# host, not just Mica's. If you use Tailscale Serve for other
# things on this machine, you'll need to re-add those after.

set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale not installed; nothing to do."
  exit 0
fi

tailscale serve reset

PORT="${MICA_FRONTEND_PORT:-5173}"
echo "✓ HTTPS proxy off."
echo "  Mica (if still running) is reachable on http://localhost:${PORT} via VSCode port-forwarding."
