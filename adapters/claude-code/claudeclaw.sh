#!/bin/bash
# ClaudeClaw - Main daemon using tmux + queue processor + Mochat

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="claudeclaw"
LOG_DIR="$SCRIPT_DIR/.claudeclaw/logs"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# Read key from .env file without sourcing it
read_dotenv_value() {
    local key="$1"
    local env_file="$SCRIPT_DIR/.env"
    if [ ! -f "$env_file" ]; then
        return 1
    fi

    local line
    line=$(grep -E "^[[:space:]]*${key}=" "$env_file" | tail -n 1)
    if [ -z "$line" ]; then
        return 1
    fi

    local value="${line#*=}"
    value="${value%$'\r'}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s' "$value"
}

is_truthy() {
    case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

is_mochat_enabled() {
    local raw="${MOCHAT_ENABLED:-}"
    if [ -z "$raw" ]; then
        raw="$(read_dotenv_value MOCHAT_ENABLED 2>/dev/null || true)"
    fi
    is_truthy "$raw"
}

# Check if session exists
session_exists() {
    tmux has-session -t "=$TMUX_SESSION" 2>/dev/null
}

# Start daemon
start_daemon() {
    if session_exists; then
        echo -e "${YELLOW}Session already running${NC}"
        return 1
    fi

    log "Starting ClaudeClaw daemon..."

    # Check if Node.js dependencies are installed
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
        cd "$SCRIPT_DIR"
        npm install
    fi

    # Check Mochat config
    if ! is_mochat_enabled; then
        echo -e "${RED}✗ Mochat channel is not enabled${NC}"
        echo ""
        echo "Set MOCHAT_ENABLED=true in .env to enable. Example:"
        echo ""
        echo "  cp .env.example .env"
        echo "  # Edit .env with your credentials"
        echo ""
        return 1
    fi

    echo -e "${GREEN}✓ Mochat channel enabled${NC}"

    # Create detached tmux session with 4 panes
    tmux new-session -d -s "$TMUX_SESSION" -n "claudeclaw" -c "$SCRIPT_DIR"

    # Split into 4 panes: 2 rows, 2 columns
    tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
    tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"
    tmux split-window -h -t "$TMUX_SESSION:0.2" -c "$SCRIPT_DIR"

    # Pane 0 (top-left): Mochat client
    tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && ./node_modules/.bin/tsx mochat-client.ts" C-m

    # Pane 1 (top-right): Queue processor
    tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && ./node_modules/.bin/tsx queue-processor.ts" C-m

    # Pane 2 (bottom-left): Heartbeat
    tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && ./heartbeat-cron.sh" C-m

    # Pane 3 (bottom-right): Logs
    tmux send-keys -t "$TMUX_SESSION:0.3" "cd '$SCRIPT_DIR' && tail -f .claudeclaw/logs/queue.log" C-m

    # Set pane titles
    tmux select-pane -t "$TMUX_SESSION:0.0" -T "Mochat"
    tmux select-pane -t "$TMUX_SESSION:0.1" -T "Queue"
    tmux select-pane -t "$TMUX_SESSION:0.2" -T "Heartbeat"
    tmux select-pane -t "$TMUX_SESSION:0.3" -T "Logs"

    echo ""
    echo -e "${GREEN}✓ ClaudeClaw started${NC}"
    echo ""
    echo -e "${BLUE}Tmux Session Layout:${NC}"
    echo "  ┌──────────────┬──────────────┐"
    echo "  │   Mochat     │    Queue     │"
    echo "  ├──────────────┼──────────────┤"
    echo "  │  Heartbeat   │    Logs      │"
    echo "  └──────────────┴──────────────┘"
    echo ""
    echo -e "${GREEN}Commands:${NC}"
    echo "  Status:  ./claudeclaw.sh status"
    echo "  Logs:    ./claudeclaw.sh logs mochat"
    echo "           ./claudeclaw.sh logs queue"
    echo "  Attach:  tmux attach -t $TMUX_SESSION"
    echo "  Stop:    ./claudeclaw.sh stop"
    echo ""

    log "Daemon started with 4 panes (Mochat + Queue + Heartbeat + Logs)"
}

# Stop daemon
stop_daemon() {
    log "Stopping ClaudeClaw..."

    if session_exists; then
        tmux kill-session -t "=$TMUX_SESSION"
    fi

    # Kill any remaining processes
    pkill -f "mochat-client.ts" || true
    pkill -f "queue-processor.ts" || true
    pkill -f "heartbeat-cron.sh" || true

    echo -e "${GREEN}✓ ClaudeClaw stopped${NC}"
    log "Daemon stopped"
}

# Send message to Claude and get response
send_message() {
    local message="$1"
    local source="${2:-manual}"

    log "[$source] Sending: ${message:0:50}..."

    # Use claude -c -p to continue and get final response
    cd "$SCRIPT_DIR"
    RESPONSE=$(claude --dangerously-skip-permissions -c -p "$message" 2>&1)

    echo "$RESPONSE"

    log "[$source] Response length: ${#RESPONSE} chars"
}

# Status
status_daemon() {
    echo -e "${BLUE}ClaudeClaw Status${NC}"
    echo "==============="
    echo ""

    if session_exists; then
        echo -e "Tmux Session: ${GREEN}Running${NC}"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
    else
        echo -e "Tmux Session: ${RED}Not Running${NC}"
        echo "  Start: ./claudeclaw.sh start"
    fi

    echo ""

    if pgrep -f "mochat-client.ts" > /dev/null; then
        echo -e "Mochat Client: ${GREEN}Running${NC}"
    else
        echo -e "Mochat Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "queue-processor.ts" > /dev/null; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    if pgrep -f "heartbeat-cron.sh" > /dev/null; then
        echo -e "Heartbeat: ${GREEN}Running${NC}"
    else
        echo -e "Heartbeat: ${RED}Not Running${NC}"
    fi

    echo ""
    echo "Recent Mochat Activity:"
    echo "────────────────────────"
    tail -n 5 "$LOG_DIR/mochat.log" 2>/dev/null || echo "  No Mochat activity yet"

    echo ""
    echo "Recent Heartbeats:"
    echo "─────────────────"
    tail -n 3 "$LOG_DIR/heartbeat.log" 2>/dev/null || echo "  No heartbeat logs yet"

    echo ""
    echo "Logs:"
    echo "  Mochat:    tail -f $LOG_DIR/mochat.log"
    echo "  Queue:     tail -f $LOG_DIR/queue.log"
    echo "  Heartbeat: tail -f $LOG_DIR/heartbeat.log"
    echo "  Daemon:    tail -f $LOG_DIR/daemon.log"
}

# View logs
logs() {
    case "${1:-mochat}" in
        mochat|mc)
            touch "$LOG_DIR/mochat.log"
            tail -f "$LOG_DIR/mochat.log"
            ;;
        queue|q)
            touch "$LOG_DIR/queue.log"
            tail -f "$LOG_DIR/queue.log"
            ;;
        heartbeat|hb)
            touch "$LOG_DIR/heartbeat.log"
            tail -f "$LOG_DIR/heartbeat.log"
            ;;
        daemon|all)
            touch "$LOG_DIR/daemon.log"
            tail -f "$LOG_DIR/daemon.log"
            ;;
        *)
            echo "Usage: $0 logs [mochat|queue|heartbeat|daemon]"
            ;;
    esac
}

case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    send)
        if [ -z "$2" ]; then
            echo "Usage: $0 send <message>"
            exit 1
        fi
        send_message "$2" "cli"
        ;;
    logs)
        logs "$2"
        ;;
    reset)
        echo -e "${YELLOW}🔄 Resetting conversation...${NC}"
        touch "$SCRIPT_DIR/.claudeclaw/reset_flag"
        echo -e "${GREEN}✓ Reset flag set${NC}"
        echo ""
        echo "The next message will start a fresh conversation (without -c)."
        echo "After that, conversation will continue normally."
        ;;
    attach)
        tmux attach -t "=$TMUX_SESSION"
        ;;
    *)
        echo -e "${BLUE}ClaudeClaw - Claude Code + Mochat${NC}"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|send|logs|reset|attach}"
        echo ""
        echo "Commands:"
        echo "  start          Start ClaudeClaw"
        echo "  stop           Stop all processes"
        echo "  restart        Restart ClaudeClaw"
        echo "  status         Show current status"
        echo "  send <msg>     Send message to Claude manually"
        echo "  logs [type]    View logs (mochat|queue|heartbeat|daemon)"
        echo "  reset          Reset conversation (next message starts fresh)"
        echo "  attach         Attach to tmux session"
        echo ""
        echo "Examples:"
        echo "  $0 start"
        echo "  $0 status"
        echo "  $0 send 'What time is it?'"
        echo "  $0 reset"
        echo "  $0 logs queue"
        echo ""
        exit 1
        ;;
esac
