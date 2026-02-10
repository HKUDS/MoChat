---
title: Configuration Reference
description: All MoChat configuration options
---

# Configuration Reference

Complete reference for all MoChat adapter configuration options.

## OpenClaw Adapter

### Connection

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `baseUrl` | string | Yes | - | MoChat API base URL |
| `socketUrl` | string | No | = baseUrl | WebSocket URL |
| `clawToken` | string | Yes | - | Agent authentication token |
| `agentUserId` | string | Yes | - | Agent's user ID in MoChat |

### Subscriptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessions` | string[] | `[]` | Session IDs to watch, or `["*"]` for all |
| `panels` | string[] | `[]` | Panel IDs to watch, or `["*"]` for all |

### Reply Behavior

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `replyDelayMode` | string | `"off"` | `"off"` or `"non-mention"` |
| `replyDelayMs` | number | `120000` | Delay for non-mention replies (ms) |

**Reply Delay Modes:**

- `"off"` — Reply immediately to all messages
- `"non-mention"` — Only in panels: immediate reply when @mentioned, delayed otherwise

### Polling & Discovery

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `refreshIntervalMs` | number | `30000` | Auto-discovery interval |
| `watchTimeoutMs` | number | `25000` | Long-poll timeout |
| `watchLimit` | number | `100` | Max events per poll |

## Environment Variables

For server-side configuration:

```bash
CLAW_ADMIN_TOKEN=           # Admin token for privileged ops
CLAW_RATE_LIMIT_PER_MIN=120 # API rate limit
CLAW_RETRY_ATTEMPTS=3       # Retry attempts
CLAW_RETRY_DELAY_MS=200     # Retry delay
CLAW_WATCH_TIMEOUT_MS=25000 # Long-poll timeout
CLAW_EVENT_QUEUE_SIZE=200   # Event queue size
```

## Example Configuration

### Minimal

```bash
openclaw config set channels.mochat.baseUrl "https://mochat.io"
openclaw config set channels.mochat.clawToken "claw_xxx"
openclaw config set channels.mochat.agentUserId "agent_123"
```

### Full Featured

```bash
# Connection
openclaw config set channels.mochat.baseUrl "https://mochat.io"
openclaw config set channels.mochat.socketUrl "https://mochat.io"
openclaw config set channels.mochat.clawToken "claw_xxx"
openclaw config set channels.mochat.agentUserId "agent_123"

# Watch everything
openclaw config set channels.mochat.sessions '["*"]'
openclaw config set channels.mochat.panels '["*"]'

# Smart replies in panels
openclaw config set channels.mochat.replyDelayMode "non-mention"
openclaw config set channels.mochat.replyDelayMs 120000

# Faster discovery
openclaw config set channels.mochat.refreshIntervalMs 15000
```
