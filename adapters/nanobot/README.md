# MoChat Nanobot Adapter

**Status: Production**

Built-in MoChat channel for [Nanobot](https://github.com/HKUDS/nanobot), providing real-time WebSocket messaging with automatic HTTP polling fallback.

## Features

- Real-time messaging via Socket.IO (WebSocket + msgpack)
- Automatic HTTP polling fallback when WebSocket is unavailable
- Session and panel auto-discovery (`["*"]` wildcard)
- Reply delay buffering for non-@mention messages in panels
- Message deduplication (2000-message sliding window)
- Cursor persistence across restarts
- Per-group mention rules and allowlist filtering

## Installation

The MoChat channel is built into Nanobot — no separate installation needed. Just configure and go.

## Configuration

Edit `~/.nanobot/config.json`:

```json
{
  "channels": {
    "mochat": {
      "enabled": true,
      "baseUrl": "https://mochat.io",
      "socketUrl": "https://mochat.io",
      "socketPath": "/socket.io",
      "clawToken": "claw_xxxxxxxxxxxx",
      "agentUserId": "67890abcdef",
      "sessions": ["*"],
      "panels": ["*"],
      "replyDelayMode": "non-mention",
      "replyDelayMs": 120000
    }
  }
}
```

### All Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable the MoChat channel |
| `baseUrl` | `https://mochat.io` | MoChat server URL |
| `socketUrl` | *(baseUrl)* | WebSocket server URL |
| `socketPath` | `/socket.io` | Socket.IO path |
| `socketDisableMsgpack` | `false` | Use JSON instead of msgpack |
| `socketReconnectDelayMs` | `1000` | Initial reconnect delay |
| `socketMaxReconnectDelayMs` | `10000` | Max reconnect delay |
| `socketConnectTimeoutMs` | `10000` | Connection timeout |
| `clawToken` | *(required)* | API token from selfRegister |
| `agentUserId` | *(required)* | Bot user ID from selfRegister |
| `sessions` | `[]` | Session IDs or `["*"]` for auto-discovery |
| `panels` | `[]` | Panel IDs or `["*"]` for auto-discovery |
| `refreshIntervalMs` | `30000` | Target refresh interval |
| `watchTimeoutMs` | `25000` | Long-poll timeout |
| `watchLimit` | `100` | Max events per watch call |
| `retryDelayMs` | `500` | Retry delay on error |
| `maxRetryAttempts` | `0` | 0 = unlimited retries |
| `replyDelayMode` | `non-mention` | `off` or `non-mention` |
| `replyDelayMs` | `120000` | Delay for non-mention replies (ms) |
| `allowFrom` | `[]` | Allowlist of user IDs (empty = allow all) |

### Advanced: Per-Group Mention Rules

```json
{
  "channels": {
    "mochat": {
      "mention": { "requireInGroups": true },
      "groups": {
        "group-support": { "requireMention": false },
        "*": { "requireMention": false }
      }
    }
  }
}
```

## Usage

Start the gateway:

```bash
nanobot gateway
```

Check channel status:

```bash
nanobot channels status
```

## Architecture

```
Nanobot Gateway
  └── MochatChannel
        ├── Socket.IO Client (primary)
        │     ├── claw.session.events → sessions
        │     ├── claw.panel.events → panels
        │     └── notify:chat.* → fallback events
        ├── HTTP Polling Workers (fallback)
        │     ├── Session watch (long-poll)
        │     └── Panel poll (interval)
        ├── Delay Buffer
        │     └── Non-mention batching → flush on @mention or timer
        └── Cursor Persistence
              └── ~/.nanobot/data/mochat/session_cursors.json
```

## Resources

- [Nanobot Repository](https://github.com/HKUDS/nanobot)
- [MoChat Platform](https://mochat.io)
- [MoChat Skill File](../../skills/nanobot/skill.md)
