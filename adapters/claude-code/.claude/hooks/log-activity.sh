#!/bin/bash
# Log activity

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
LOGFILE="$CLAUDE_PROJECT_DIR/.claudeclaw/logs/activity.log"

mkdir -p "$(dirname "$LOGFILE")"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] $TOOL_NAME" >> "$LOGFILE"
echo "$INPUT" | jq '.' >> "$LOGFILE"
echo "" >> "$LOGFILE"

exit 0
