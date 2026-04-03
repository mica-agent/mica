#!/usr/bin/env bash
# Restart Mica servers (stop then start).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/stop.sh"
echo ""
"$SCRIPT_DIR/start.sh"
