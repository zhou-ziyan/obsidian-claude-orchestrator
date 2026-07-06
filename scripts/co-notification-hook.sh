#!/usr/bin/env bash
# Claude Code Notification hook — writes an "asking" signal for the
# Orchestrator plugin when Claude requests permission.
#
# Only permission-style notifications are forwarded: the generic
# "waiting for your input" idle notification fires 60s after any stop
# and would mislabel a normally idle session as waiting_for_user.

set -euo pipefail

SIGNAL_DIR="/tmp/co-stop"
mkdir -p "$SIGNAL_DIR"

INPUT=$(cat)

TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "unknown")
CO_VAULT=$(tmux display-message -p '#{@co_vault}' 2>/dev/null || echo "")
TIMESTAMP=$(date +%s)

SIGNAL=$(printf '%s' "$INPUT" | /usr/bin/python3 -c "
import sys, json

data = json.load(sys.stdin)
message = str(data.get('message', ''))
if 'permission' not in message.lower():
    sys.exit(0)

data['tmux_session'] = '$TMUX_SESSION'
data['timestamp'] = $TIMESTAMP
data['vault'] = '$CO_VAULT'
data['stop_reason'] = 'asking'
json.dump(data, sys.stdout)
")

if [ -z "$SIGNAL" ]; then
    exit 0
fi

# Atomic write (see co-stop-hook.sh). The -notify suffix keeps a Stop
# signal in the same second from being overwritten.
SIGNAL_FILE="$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}-notify.json"
echo "$SIGNAL" > "$SIGNAL_FILE.tmp"
mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
