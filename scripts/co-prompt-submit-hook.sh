#!/usr/bin/env bash
# Claude UserPromptSubmit hook — disarms Queue before the turn starts.

set -euo pipefail

SIGNAL_DIR="${CO_SIGNAL_DIR:-/tmp/co-stop}"
mkdir -p "$SIGNAL_DIR"
INPUT=$(cat)
TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "unknown")
CO_VAULT=$(tmux display-message -p '#{@co_vault}' 2>/dev/null || echo "")
TIMESTAMP=$(date +%s)

SIGNAL=$(printf '%s' "$INPUT" | /usr/bin/python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
data['tmux_session'] = '$TMUX_SESSION'
data['timestamp'] = $TIMESTAMP
data['vault'] = '$CO_VAULT'
data['provider'] = 'claude'
data['stop_reason'] = 'started'
json.dump(data, sys.stdout)
")

if [ -z "$SIGNAL" ]; then exit 0; fi
SIGNAL_FILE="$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}-claude-start.json"
echo "$SIGNAL" > "$SIGNAL_FILE.tmp"
mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
