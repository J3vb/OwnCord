# WebSocket Protocol Spec

All client-server communication (except file uploads and
admin panel) happens over a single WebSocket connection.
Messages are JSON with a `type` and `payload`.

## Message Format

```json
{
  "type": "message_type",
  "id": "unique-request-id",
  "payload": { }
}
```

- `type` — string, required. Determines how payload is interpreted.
- `id` — string, optional. Client-generated UUID for request/response correlation.
- `payload` — object, required. Contents vary by type.

Server responses to client requests include the same `id` for correlation.

---

## Authentication

### Client → Server

```json
{ "type": "auth", "payload": { "token": "session-token-here" } }
```

### Server → Client (success)

```json
{
  "type": "auth_ok",
  "payload": {
    "user": {
      "id": 1, "username": "alex",
      "avatar": "uuid.png", "role": "admin"
    },
    "server_name": "My Server",
    "motd": "Welcome!"
  }
}
```

### Server → Client (failure)

```json
{ "type": "auth_error", "payload": { "message": "Invalid or expired token" } }
```

Connection is closed by server after auth_error.

---

## Chat Messages

### Send Message (Client → Server)

```json
{
  "type": "chat_send",
  "id": "req-uuid",
  "payload": {
    "channel_id": 5,
    "content": "Hello everyone!",
    "reply_to": null,
    "attachments": ["upload-uuid-1"]
  }
}
```

### Message Broadcast (Server → Client)

```json
{
  "type": "chat_message",
  "payload": {
    "id": 1042, "channel_id": 5,
    "user": {
      "id": 1, "username": "alex",
      "avatar": "uuid.png"
    },
    "content": "Hello everyone!",
    "reply_to": null,
    "attachments": [{
      "id": "upload-uuid-1",
      "filename": "photo.jpg",
      "size": 204800,
      "mime": "image/jpeg",
      "url": "/files/upload-uuid-1"
    }],
    "timestamp": "2026-03-14T10:30:00Z"
  }
}
```

### Send Ack (Server → Client)

```json
{
  "type": "chat_send_ok",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042,
    "timestamp": "2026-03-14T10:30:00Z"
  }
}
```

### Edit Message (Client → Server)

```json
{
  "type": "chat_edit",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042,
    "content": "Hello everyone! (edited)"
  }
}
```

### Edit Broadcast (Server → Client)

```json
{
  "type": "chat_edited",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "content": "Hello everyone! (edited)",
    "edited_at": "2026-03-14T10:31:00Z"
  }
}
```

### Delete Message (Client → Server)

```json
{ "type": "chat_delete", "id": "req-uuid", "payload": { "message_id": 1042 } }
```

### Delete Broadcast (Server → Client)

```json
{ "type": "chat_deleted", "payload": { "message_id": 1042, "channel_id": 5 } }
```

### Reaction Add/Remove (Client → Server)

```json
{ "type": "reaction_add", "payload": { "message_id": 1042, "emoji": "👍" } }
{ "type": "reaction_remove", "payload": { "message_id": 1042, "emoji": "👍" } }
```

### Reaction Broadcast (Server → Client)

```json
{
  "type": "reaction_update",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "emoji": "👍",
    "user_id": 1,
    "action": "add"
  }
}
```

---

## Typing Indicators

### Client → Server (throttle to 1 per 3 seconds)

```json
{ "type": "typing_start", "payload": { "channel_id": 5 } }
```

### Server → Client (broadcast to channel members)

```json
{
  "type": "typing",
  "payload": {
    "channel_id": 5,
    "user_id": 1,
    "username": "alex"
  }
}
```

Client-side: show indicator for 5 seconds, reset on new typing event from same user.

---

## Presence

### Presence Client → Server

```json
{ "type": "presence_update", "payload": { "status": "online" } }
```

Status values: `online`, `idle`, `dnd`, `offline`

### Presence Server → Client (broadcast)

```json
{ "type": "presence", "payload": { "user_id": 1, "status": "online" } }
```

Server auto-sets `idle` after 10 minutes of no WebSocket activity.

---

## Channel Updates

### Server → Client (on channel created/edited/deleted/reordered)

```json
{
  "type": "channel_create",
  "payload": {
    "id": 8, "name": "gaming",
    "type": "text",
    "category": "Hangout", "position": 3
  }
}
{
  "type": "channel_update",
  "payload": {
    "id": 8, "name": "gaming-talk",
    "position": 4
  }
}
{ "type": "channel_delete", "payload": { "id": 8 } }
```

Channel types: `text`, `voice`, `announcement`

---

## Voice Signaling

### Join Voice Channel (Client → Server)

```json
{ "type": "voice_join", "payload": { "channel_id": 10 } }
```

### Server → Client (voice state updates, broadcast to channel)

```json
{
  "type": "voice_state",
  "payload": {
    "channel_id": 10, "user_id": 1,
    "username": "alex",
    "muted": false, "deafened": false,
    "speaking": false,
    "camera": false, "screenshare": false
  }
}
```

### Voice User Left (Server → Client)

```json
{ "type": "voice_leave", "payload": { "channel_id": 10, "user_id": 1 } }
```

### voice_token (Server → Client)

Sent after a successful `voice_join`. Contains the LiveKit access token
and server URL for the client to connect directly to LiveKit.

```json
{
  "type": "voice_token",
  "payload": {
    "channel_id": 10,
    "token": "eyJhbGciOi...",
    "url": "ws://localhost:7880"
  }
}
```

- `channel_id` (number) — the voice channel joined
- `token` (string) — LiveKit JWT access token
- `url` (string) — LiveKit WebSocket URL (e.g. `ws://localhost:7880`)

### Voice Config (Server → Client, sent after voice_join acceptance)

```json
{
  "type": "voice_config",
  "payload": {
    "channel_id": 10, "quality": "medium", "bitrate": 64000,
    "max_users": 50
  }
}
```

Client uses `bitrate` to configure the Opus encoder. Other fields are
informational for UI. (`threshold_mode` and `top_speakers` fields have
been removed — LiveKit handles audio mixing and speaker selection
internally.)

### Voice Control (Client → Server)

```json
{ "type": "voice_mute", "payload": { "muted": true } }
{ "type": "voice_deafen", "payload": { "deafened": true } }
```

### Voice Camera / Screenshare (Client → Server)

```json
{ "type": "voice_camera", "payload": { "enabled": true } }
{ "type": "voice_screenshare", "payload": { "enabled": true } }
```

Requires `USE_VIDEO` (bit 11) or `SHARE_SCREEN` (bit 12) permission.
Rate limit: 2/sec per user.

**Note:** Active speaker detection (`voice_speakers`) is no longer a
server→client WebSocket message. Speaker detection is handled client-side
via LiveKit SDK events (`ParticipantEvent.IsSpeakingChanged`).

---

## Member Updates

### Server → Client

```json
{
  "type": "member_join",
  "payload": {
    "user": {
      "id": 5, "username": "newuser",
      "avatar": null, "role": "member"
    }
  }
}
{ "type": "member_leave", "payload": { "user_id": 5 } }
{ "type": "member_update", "payload": { "user_id": 5, "role": "moderator" } }
{ "type": "member_ban", "payload": { "user_id": 5 } }
```

---

## Server Restart

### Restart Server → Client

```json
{
  "type": "server_restart",
  "payload": {
    "reason": "update",
    "delay_seconds": 5
  }
}
```

- `reason` (string): Why the server is restarting. Currently only `"update"`.
- `delay_seconds` (integer): How many seconds until the server shuts down.

Client behavior: Display a banner ("Server restarting..."),
then auto-reconnect after the delay expires.

---

## Initial State (sent after auth_ok)

### Ready Server → Client

```json
{
  "type": "ready",
  "payload": {
    "channels": [
      {
        "id": 1, "name": "general",
        "type": "text", "category": "Main",
        "position": 0, "unread_count": 3,
        "last_message_id": 1040
      },
      {
        "id": 10, "name": "voice-chat",
        "type": "voice", "category": "Main",
        "position": 1
      }
    ],
    "members": [
      {
        "id": 1, "username": "alex",
        "avatar": "uuid.png",
        "role": "admin", "status": "online"
      },
      {
        "id": 2, "username": "jordan",
        "avatar": null,
        "role": "member", "status": "idle"
      }
    ],
    "voice_states": [
      { "channel_id": 10, "user_id": 2, "muted": false, "deafened": false }
    ],
    "roles": [
      {
        "id": 1, "name": "Owner",
        "color": "#E74C3C",
        "permissions": 2147483647
      },
      {
        "id": 2, "name": "Admin",
        "color": "#F39C12",
        "permissions": 1073741823
      },
      { "id": 3, "name": "Member", "color": null, "permissions": 1049601 }
    ]
  }
}
```

---

## Message History (REST, not WebSocket)

Fetched via REST API, not WebSocket, to keep the WS connection lean.

```text
GET /api/channels/{id}/messages?before={msg_id}&limit=50
```

---

## Error Format

Any request that fails returns:

```json
{
  "type": "error",
  "id": "original-req-uuid",
  "payload": {
    "code": "FORBIDDEN",
    "message": "No permission to post here"
  }
}
```

Error codes: `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `INVALID_INPUT`,
`SERVER_ERROR`, `CHANNEL_FULL`, `VOICE_ERROR`

---

## Rate Limits

- Chat messages: 10/sec per user
- Typing events: 1/3sec per user per channel
- Presence updates: 1/10sec per user
- Reactions: 5/sec per user
- Voice signaling: 20/sec per user
- Voice camera/screenshare: 2/sec per user

Server sends `rate_limited` error with `retry_after` in seconds.
