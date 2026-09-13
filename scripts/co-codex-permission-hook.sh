#!/usr/bin/env bash
# Codex PermissionRequest hook — writes an "asking" signal.
#
# Codex has no Notification event; PermissionRequest is what fires while the
# TUI blocks on an approval prompt. Unlike Claude's Notification hook there
# is nothing to filter: every PermissionRequest is, by definition, the agent
# waiting on the user.

set -euo pipefail

# Overridable so tests can drive the hook without writing into the
# live signal directory a running plugin is consuming.
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
    # Garbage in must not become a confident turn-end out.
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

data['tmux_session'] = '$TMUX_SESSION'
data['timestamp'] = $TIMESTAMP
data['vault'] = '$CO_VAULT'
data['provider'] = 'codex'
data['stop_reason'] = 'asking'
json.dump(data, sys.stdout)
")

if [ -z "$SIGNAL" ]; then
    exit 0
fi

SIGNAL_FILE="$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}-codex-perm.json"
echo "$SIGNAL" > "$SIGNAL_FILE.tmp"
mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
