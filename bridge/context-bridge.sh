#!/bin/bash
# BrainDrain CC — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/braindrain/{session_id}.json
# Configure in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "/path/to/context-bridge.sh" }

input=$(cat)

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

if [ -z "$session_id" ]; then
  exit 0
fi

mkdir -p "$HOME/.claude/braindrain"

echo "$input" | python3 -c "
import sys, json, time

data = json.load(sys.stdin)
cw = data.get('context_window', {})

output = {
    'cwd': data.get('cwd', ''),
    'used_percentage': cw.get('used_percentage', 0),
    'remaining_percentage': cw.get('remaining_percentage', 100),
    'total_input_tokens': cw.get('total_input_tokens', 0),
    'total_output_tokens': cw.get('total_output_tokens', 0),
    'context_window_size': cw.get('context_window_size', 200000),
    'model': data.get('model', {}).get('id', 'unknown') if isinstance(data.get('model'), dict) else data.get('model', 'unknown'),
    'session_id': data.get('session_id', ''),
    'timestamp': time.time()
}

print(json.dumps(output, indent=2))
" > "$HOME/.claude/braindrain/$session_id.json" 2>/dev/null
