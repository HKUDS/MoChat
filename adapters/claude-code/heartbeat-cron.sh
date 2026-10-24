#!/bin/bash
# Heartbeat - Periodically prompts Claude via queue system

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEARTBEAT_FILE="$SCRIPT_DIR/.claudeclaw/heartbeat.md"
LOG_FILE="$SCRIPT_DIR/.claudeclaw/logs/heartbeat.log"
QUEUE_INCOMING="$SCRIPT_DIR/.claudeclaw/queue/incoming"
INTERVAL=300  # 5 minutes

mkdir -p "$QUEUE_INCOMING"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "Heartbeat started (interval: ${INTERVAL}s)"

while true; do
    sleep "$INTERVAL"

    log "Heartbeat check..."

    # Read heartbeat prompt
    if [ -f "$HEARTBEAT_FILE" ]; then
        PROMPT=$(cat "$HEARTBEAT_FILE")
    else
        PROMPT="Quick status check: Any pending tasks? Keep response brief."
    fi

    # Generate unique message ID
    MESSAGE_ID="heartbeat_$(date +%s)_$$"

    # Encode the prompt as JSON so quotes, backslashes, and newlines remain valid.
    printf '%s' "$PROMPT" | \
        MESSAGE_ID="$MESSAGE_ID" HEARTBEAT_TIMESTAMP="$(date +%s)000" \
        node -e '
const fs = require("node:fs");
const outputPath = process.argv[1];
const prompt = fs.readFileSync(0, "utf8");
const payload = {
  channel: "heartbeat",
  sender: "System",
  senderId: "heartbeat",
  message: prompt,
  timestamp: Number(process.env.HEARTBEAT_TIMESTAMP),
  messageId: process.env.MESSAGE_ID,
};
fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
' "$QUEUE_INCOMING/${MESSAGE_ID}.json"

    log "✓ Heartbeat queued: $MESSAGE_ID"

    # Optional: wait a bit and check if response was created
    sleep 10

    # Check for response (optional logging)
    RESPONSE_FILE="$SCRIPT_DIR/.claudeclaw/queue/outgoing/${MESSAGE_ID}.json"
    if [ -f "$RESPONSE_FILE" ]; then
        RESPONSE=$(cat "$RESPONSE_FILE" | jq -r '.message' 2>/dev/null || echo "")
        if [ -n "$RESPONSE" ]; then
            log "Response: ${RESPONSE:0:100}..."
            # Clean up response file (we don't need to send it anywhere)
            rm "$RESPONSE_FILE"
        fi
    fi
done
