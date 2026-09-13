#!/usr/bin/env bash
# Codex Stop hook — writes a turn-end signal for the Orchestrator plugin.
#
# Codex's payload differs from Claude Code's: it carries the reply directly
# as `last_assistant_message`, so there is no transcript JSONL to parse.
# It also carries `turn_id`, which the plugin uses (with `provider` and
# `session_id`) to tell Codex turns apart from Claude ones — both engines
# emit 36-character UUIDs, so the provider field is the only safe
# discriminator.

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
import sys, json, re

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

# Same classification Claude's hook applies, against the message Codex
# hands us directly: a trailing question or a Y/N prompt means the turn
# ended by asking, not by finishing.
text = str(data.get('last_assistant_message') or '')
tail = text[-500:]
stop_reason = 'done'
if re.search(r'[Yy]/[Nn]', tail):
    stop_reason = 'asking'
elif re.search(r'\?\s*\$', tail, re.MULTILINE):
    stop_reason = 'asking'

data['stop_reason'] = stop_reason
json.dump(data, sys.stdout)
")

if [ -z "$SIGNAL" ]; then
    exit 0
fi

# Atomic write: stage to .tmp then mv, so the watcher never reads a
# half-written file. The -codex-stop suffix keeps this from colliding with
# a Claude signal for the same session in the same second.
SIGNAL_FILE="$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}-codex-stop.json"
echo "$SIGNAL" > "$SIGNAL_FILE.tmp"
mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
