#!/usr/bin/env bash
# https-on.sh — front Mica with Tailscale Serve so iPhone Safari can hit it.
#
# Run this on the SPARK HOST, not inside the devcontainer. tailscaled
# lives on the host; the devcontainer publishes port 5173 to the host's
# localhost via the -p mapping in .devcontainer/devcontainer.json, and
# this script tells the host's Tailscale daemon to terminate HTTPS on
# behalf of that port.
#
# After this, the URL printed by `tailscale serve status` works from any
# device on your tailnet — including iPhone Safari with the Tailscale
# app running. The proxy is internal-only (Serve, not Funnel); not
# reachable from the public internet.
#
# Stop with: bash scripts/https-off.sh
#
# Override the port via env var:
#   MICA_FRONTEND_PORT=8173 bash scripts/https-on.sh

set -euo pipefail

PORT="${MICA_FRONTEND_PORT:-5173}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "ERROR: tailscale not installed on this host." >&2
  echo "  Are you running this inside the devcontainer? It must run on the SPARK HOST." >&2
  echo "  Install: curl -fsSL https://tailscale.com/install.sh | sh" >&2
  exit 1
fi

if ! tailscale status >/dev/null 2>&1; then
  echo "ERROR: tailscale daemon is not running or not authenticated." >&2
  echo "  Run: sudo tailscale up" >&2
  exit 1
fi

# Probe the host port. If nothing's there, the user probably hasn't
# started Mica or the devcontainer isn't publishing 5173 to the host.
if ! curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}"; then
  echo "WARNING: nothing answered at http://127.0.0.1:${PORT} on this host." >&2
  echo "  - Is Mica running inside the devcontainer? (scripts/start.sh)" >&2
  echo "  - Does .devcontainer/devcontainer.json publish ${PORT} via runArgs '-p ${PORT}:${PORT}'?" >&2
  echo "    (Rebuild the devcontainer after changing this.)" >&2
  echo "  Continuing anyway — Tailscale Serve will be configured but unreachable until the port is up." >&2
fi

# Configure Serve. --bg persists across shell exit / reboot until reset.
# Modern (1.50+) syntax: `tailscale serve --bg <port>` — auto-binds the
# tailnet HTTPS port (443) to localhost:<port>. The older `--bg https /
# proxy <port>` 4-argument form was removed.
#
# By default Tailscale requires root for serve-config edits. If we get
# "Access denied: serve config denied", point the user at the one-time
# operator-grant command and bail.
if ! tailscale serve --bg "${PORT}" 2> /tmp/tailscale-serve-err; then
  ERR=$(cat /tmp/tailscale-serve-err)
  rm -f /tmp/tailscale-serve-err
  echo "$ERR" >&2
  if echo "$ERR" | grep -qi "access denied\|operator"; then
    echo "" >&2
    echo "Tailscale Serve requires root by default. Two options:" >&2
    echo "" >&2
    echo "  ONE-TIME (recommended; no sudo needed thereafter):" >&2
    echo "    sudo tailscale set --operator=\$USER" >&2
    echo "    bash scripts/https-on.sh" >&2
    echo "" >&2
    echo "  PER-RUN:" >&2
    echo "    sudo bash scripts/https-on.sh" >&2
    echo "" >&2
  fi
  exit 1
fi
rm -f /tmp/tailscale-serve-err

echo ""
echo "✓ HTTPS proxy configured. Tailnet URL:"
URL=$(tailscale serve status 2>/dev/null | sed -n 's|^\(https://[^ ]*\).*|  \1|p' | head -1)
if [ -n "$URL" ]; then
  echo "$URL"
else
  echo "  (run \`tailscale serve status\` to print)"
fi

echo ""
echo "Next steps:"
echo "  1. Install Tailscale on iOS (App Store)"
echo "  2. Sign into the same tailnet account"
echo "  3. Open the URL above in Safari"
echo ""
echo "Stop with: bash scripts/https-off.sh"
