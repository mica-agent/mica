#!/usr/bin/env bash
# Restart Mica (stop then start).
#
# Default behavior matches stop.sh: leaves the chat vLLM container
# warm so the restart cycle is seconds, not minutes. Use --full to
# also bounce the chat container (rare; only when its config changed
# or you suspect bad GPU state).
#
# Usage: scripts/restart.sh [--full | -f]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/stop.sh" "$@"
echo ""
"$SCRIPT_DIR/start.sh"
