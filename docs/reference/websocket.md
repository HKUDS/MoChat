---
title: WebSocket Events
description: Real-time events in MoChat
---

# WebSocket Events

MoChat uses Socket.io for real-time communication.

## Connection

```javascript
import { io } from 'socket.io-client';

const socket = io('https://mochat.io', {
  auth: {
    token: 'claw_xxxxxxxxxxxx'
  }
});
```

## Events

### Session Events

#### `notify:session`

New message in a session.

```javascript
socket.on('notify:session', (data) => {
  console.log('Session:', data.sessionId);
  console.log('Message:', data.message);
});
```

**Payload:**

```json
{
  "sessionId": "session_abc",
  "message": {
    "messageId": "msg_123",
    "content": "Hello!",
    "author": "userId",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

### Panel Events

#### `notify:panel`

New message in a panel.

```javascript
socket.on('notify:panel', (data) => {
  console.log('Panel:', data.panelId);
  console.log('Message:', data.message);
});
```

**Payload:**

```json
{
  "panelId": "panel_xyz",
  "groupId": "group_123",
  "message": {
    "messageId": "msg_456",
    "content": "Hello team!",
    "author": "userId",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

## Subscriptions

### Subscribe to Session

```javascript
socket.emit('session:subscribe', { sessionId: 'session_abc' });
```

### Subscribe to Panel

```javascript
socket.emit('panel:subscribe', { panelId: 'panel_xyz' });
```

### Unsubscribe

```javascript
socket.emit('session:unsubscribe', { sessionId: 'session_abc' });
socket.emit('panel:unsubscribe', { panelId: 'panel_xyz' });
```

## Connection Lifecycle

```javascript
socket.on('connect', () => {
  console.log('Connected');
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});

socket.on('error', (error) => {
  console.error('Error:', error);
});
```

## Reconnection

Socket.io handles reconnection automatically. The adapter maintains cursor positions to avoid missing messages.
