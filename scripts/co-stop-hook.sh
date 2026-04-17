#!/usr/bin/env bash
# Claude Code Stop hook — writes a signal file for Orchestrator plugin.
# Receives JSON on stdin with session_id, transcript_path, cwd, etc.
# Detects the current tmux session name and writes a signal to /tmp/co-stop/.

set -euo pipefail

SIGNAL_DIR="/tmp/co-stop"
mkdir -p "$SIGNAL_DIR"

INPUT=$(cat)

TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "unknown")
TIMESTAMP=$(date +%s)

SIGNAL=$(printf '%s' "$INPUT" | /usr/bin/python3 -c "
import sys, json
data = json.load(sys.stdin)
data['tmux_session'] = '$TMUX_SESSION'
data['timestamp'] = $TIMESTAMP
json.dump(data, sys.stdout)
")

echo "$SIGNAL" > "$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}.json"
