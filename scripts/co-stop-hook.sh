#!/usr/bin/env bash
# Claude Code Stop hook — writes a signal file for Orchestrator plugin.
# Receives JSON on stdin with session_id, transcript_path, cwd, etc.
# Detects the current tmux session name and writes a signal to /tmp/co-stop/.
# Reads transcript JSONL to classify stop as "done" or "asking".

set -euo pipefail

SIGNAL_DIR="/tmp/co-stop"
mkdir -p "$SIGNAL_DIR"

INPUT=$(cat)

TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo "unknown")
TIMESTAMP=$(date +%s)

SIGNAL=$(printf '%s' "$INPUT" | /usr/bin/python3 -c "
import sys, json, re, os

data = json.load(sys.stdin)
data['tmux_session'] = '$TMUX_SESSION'
data['timestamp'] = $TIMESTAMP

stop_reason = 'done'
tp = data.get('transcript_path', '')
if tp and os.path.isfile(tp):
    try:
        with open(tp, 'r') as f:
            lines = f.readlines()
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get('type') != 'assistant':
                continue
            content = entry.get('message', {}).get('content', [])
            text = '\n'.join(
                c.get('text', '') for c in content
                if isinstance(c, dict) and c.get('type') == 'text'
            )
            if not text:
                break
            tail = text[-500:]
            if re.search(r'[Yy]/[Nn]', tail):
                stop_reason = 'asking'
            elif re.search(r'\?\s*$', tail, re.MULTILINE):
                stop_reason = 'asking'
            break
    except Exception:
        pass

data['stop_reason'] = stop_reason
json.dump(data, sys.stdout)
")

echo "$SIGNAL" > "$SIGNAL_DIR/${TIMESTAMP}-${TMUX_SESSION}.json"
