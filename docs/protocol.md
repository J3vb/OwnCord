# WebSocket Protocol Reference

All client-server real-time communication happens over a single WebSocket connection. Messages are JSON with a `type` and `payload`.

**Related docs:**
- [api.md](api.md) -- REST endpoints (message history, file uploads, etc.)
- [schema.md](schema.md) -- Database tables and permission bitfields

---

## Table of Contents

1. [Transport Layer](#transport-layer)
2. [Message Envelope](#message-envelope)
3. [Sequence Numbers](#sequence-numbers)
4. [Authentication Flow](#authentication-flow)
5. [Heartbeat and Connection Liveness](#heartbeat-and-connection-liveness)
6. [Reconnection with State Recovery](#reconnection-with-state-recovery)
7. [Initial State (ready)](#initial-state-ready)
8. [Chat Messages](#chat-messages)
9. [Reactions](#reactions)
10. [Typing Indicators](#typing-indicators)
11. [Presence](#presence)
12. [Channel Focus](#channel-focus)
13. [Channel Updates](#channel-updates)
14. [Member Updates](#member-updates)
15. [Voice Signaling](#voice-signaling)
16. [Voice End-to-End Encryption](#voice-end-to-end-encryption)
17. [Direct Messages](#direct-messages)
18. [Server Restart](#server-restart)
19. [Error Handling](#error-handling)
20. [Rate Limits](#rate-limits)
21. [Message Type Reference Table](#message-type-reference-table)

---

## Transport Layer

### WebSocket Endpoint

```
wss://{host}/api/v1/ws
```

The client connects via the Tauri Rust backend's WS proxy rather than native WebView2 WebSocket. This is required because WebView2 rejects self-signed TLS certificates. The Rust proxy uses TOFU (Trust On First Use) certificate pinning.

### Transport Limits

| Limit | Value |
|-------|-------|
| Max read size | 1 MB |
| Max message content | 4000 runes |
| Write timeout | 10 seconds |
| Auth deadline | 10 seconds |
| Send buffer per client | 256 messages |

---

## Message Envelope

Every WebSocket message is a JSON object with these fields:

```json
{
  "type": "message_type",
  "id": "unique-request-id",
  "payload": { },
  "seq": 42
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Determines how `payload` is interpreted |
| `id` | string | Client messages only | Client-generated UUID for request/response correlation |
| `payload` | object | Yes | Contents vary by `type`. Must be present (can be `{}`). |
| `seq` | uint64 | Broadcast messages only | Monotonically increasing sequence number. Only present on server-to-client broadcast messages. |

---

## Sequence Numbers

The sequence number system enables reconnection with state recovery.

1. The server maintains an atomic `uint64` counter.
2. Every broadcast message gets the next seq number.
3. The message is stored in a 1000-event replay ring buffer.
4. The client tracks `lastSeq` from every server broadcast.

### Which Messages Get seq

| Category | Has seq? | Examples |
|----------|----------|---------|
| Channel broadcasts | Yes | `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update` |
| Global broadcasts | Yes | `presence`, `member_join`, `member_leave`, `member_update`, `member_ban`, `voice_state`, `voice_leave`, `channel_create`, `channel_update`, `channel_delete`, `server_restart` |
| Ephemeral | No | `typing` |
| DM messages | No | DM `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update`, `dm_channel_open`, `dm_channel_close` |
| Direct responses | No | `auth_ok`, `auth_error`, `chat_send_ok`, `error`, `voice_config`, `voice_token`, `pong` |

---

## Authentication Flow

### Step 1: Client Sends auth

After the WebSocket connection is established, the client sends the first message within 10 seconds:

```json
{
  "type": "auth",
  "payload": {
    "token": "session-token-from-login",
    "last_seq": 0
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | Session token obtained from `POST /api/v1/auth/login` |
| `last_seq` | uint64 | No | Last sequence number received. If > 0, server attempts replay. Default 0. |

### Step 2: Success -- auth_ok

```json
{
  "type": "auth_ok",
  "payload": {
    "user": {
      "id": 1,
      "username": "alex",
      "avatar": "uuid.png",
      "role": "admin"
    },
    "server_name": "My Server",
    "motd": "Welcome!",
    "replay_source": "none"
  }
}
```

`replay_source` reports which replay tier served this (re)connection:
`"none"` (fresh connection / full re-sync), `"buffer"` (in-memory ring
buffer), or `"db"` (persistent `events` table). See
[Reconnection with State Recovery](#reconnection-with-state-recovery).

### Step 3: Failure -- auth_error

```json
{
  "type": "auth_error",
  "payload": {
    "message": "Invalid or expired token"
  }
}
```

After sending `auth_error`, the server closes the connection.

### Step 4: ready Payload

After `auth_ok`, the server sends a `ready` message containing all initial state.

### Step 5: Member Join + Presence

The server broadcasts to all connected clients:

```json
{ "type": "member_join", "payload": { "user": { "id": 1, "username": "alex", "avatar": "uuid.png", "role": "admin" } } }
{ "type": "presence", "payload": { "user_id": 1, "status": "online" } }
```

### Periodic Session Revalidation

Every 10 messages, the server re-checks the session token against the database. If the session has been revoked, expired, or the user banned, the connection is closed immediately.

---

## Heartbeat and Connection Liveness

### Client Ping

The client sends a JSON ping every 30 seconds:

```json
{ "type": "ping", "payload": {} }
```

### Server Pong

The server responds immediately:

```json
{ "type": "pong" }
```

### Server Stale Client Sweep

Every 30 seconds, the server checks all clients. Any client with no activity for 90 seconds is forcibly disconnected. Normal chat activity also keeps the connection alive.

---

## Reconnection with State Recovery

When a connection drops, the client automatically reconnects with exponential backoff (1s to 30s max) and sends `last_seq` in the `auth` message. The server resolves the reconnect through a **3-tier replay pipeline** (cheapest first):

| Tier | Condition | Server Behavior | `replay_source` |
|------|-----------|-----------------|-----------------|
| — | `last_seq == 0` | Full flow: `auth_ok` + `ready` + `member_join` + `presence` | `none` |
| 1 | seq within the in-memory ring buffer (1000 events) | Replay flow: `auth_ok` + missed events + `presence` (no `member_join`, no `ready`). Channel-scoped events are permission-filtered (fail-closed). | `buffer` |
| 2 | seq within the persistent `events` table (max 5000 events, subject to retention) | Same replay flow, served from the cold tier | `db` |
| 3 | seq too far behind, or channel visibility changed while away | Full flow (fallback): same as `last_seq == 0` | `none` |

A visibility watermark forces the tier-3 full re-sync whenever channel
visibility changed while the client was disconnected, so permission changes
can never be replayed around.

DM events are not stored in the ring buffer; DM history persisted to the
`events` table is replayable via tier 2, and everything is always recoverable
via the full `ready` payload.

---

## Initial State (ready)

Sent once after `auth_ok` (fresh connection or replay fallback).

```json
{
  "type": "ready",
  "payload": {
    "channels": [ ... ],
    "dm_channels": [ ... ],
    "members": [ ... ],
    "voice_states": [ ... ],
    "roles": [ ... ],
    "server_name": "My Server",
    "motd": "Welcome!"
  }
}
```

### Payload Fields

**channels[]:** `id`, `name`, `type` (`text`/`voice`/`announcement`), `category`, `position`, `unread_count` (text + announcement), `last_message_id` (text + announcement)

**dm_channels[]:** `channel_id`, `recipient` (user object with `id`, `username`, `avatar`, `status`), `last_message_id`, `last_message`, `last_message_at`, `unread_count`

**members[]:** All registered users with `id`, `username`, `avatar`, `role` (lowercase name), `status`

**voice_states[]:** All users currently in any voice channel: `channel_id`, `user_id`, `muted`, `deafened`

**roles[]:** All server roles with `id`, `name`, `color`, `permissions` (bitfield)

---

## Chat Messages

### chat_send (Client -> Server)

```json
{
  "type": "chat_send",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "channel_id": 5,
    "content": "Hello everyone!",
    "reply_to": null,
    "attachments": ["upload-uuid-1"]
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `channel_id` | number | Yes | Positive integer |
| `content` | string | Yes* | Max 4000 runes. HTML-sanitized. *Can be empty if `attachments` is non-empty. |
| `reply_to` | number or null | No | Message ID being replied to |
| `attachments` | string[] | No | Upload IDs from `POST /api/v1/uploads`. Requires `ATTACH_FILES` permission. |

### chat_send_ok (Server -> Client)

Direct response to sender (no seq):

```json
{
  "type": "chat_send_ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "message_id": 1042,
    "timestamp": "2026-03-14T10:30:00Z"
  }
}
```

### chat_message (Server -> Client, broadcast)

```json
{
  "seq": 42,
  "type": "chat_message",
  "payload": {
    "id": 1042,
    "channel_id": 5,
    "user": {
      "id": 1,
      "username": "alex",
      "avatar": "uuid.png",
      "role": "admin"
    },
    "content": "Hello everyone!",
    "reply_to": null,
    "timestamp": "2026-03-14T10:30:00Z",
    "attachments": [],
    "reactions": [],
    "pinned": false
  }
}
```

### chat_edit (Client -> Server)

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

Own messages only. Max 4000 runes.

### chat_edited (Server -> Client, broadcast)

```json
{
  "seq": 43,
  "type": "chat_edited",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "content": "Hello everyone! (edited)",
    "edited_at": "2026-03-14T10:31:00Z"
  }
}
```

### chat_delete (Client -> Server)

```json
{
  "type": "chat_delete",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042
  }
}
```

Moderators with `MANAGE_MESSAGES` can delete others' messages (non-DM channels only).

### chat_deleted (Server -> Client, broadcast)

```json
{
  "seq": 44,
  "type": "chat_deleted",
  "payload": {
    "message_id": 1042,
    "channel_id": 5
  }
}
```

---

## Reactions

### reaction_add / reaction_remove (Client -> Server)

```json
{
  "type": "reaction_add",
  "payload": {
    "message_id": 1042,
    "emoji": "\ud83d\udc4d"
  }
}
```

Rate limited at 5/sec. Requires `ADD_REACTIONS` permission (or DM participant).

### reaction_update (Server -> Client, broadcast)

```json
{
  "seq": 45,
  "type": "reaction_update",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "emoji": "\ud83d\udc4d",
    "user_id": 1,
    "action": "add"
  }
}
```

`action` is `"add"` or `"remove"`.

---

## Typing Indicators

### typing_start (Client -> Server)

```json
{ "type": "typing_start", "payload": { "channel_id": 5 } }
```

Rate limited: 1 per 3 seconds per user per channel. Silently dropped when rate limited.

### typing (Server -> Client, broadcast)

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

Typing broadcasts are ephemeral -- they are NOT stored in the replay ring buffer.

---

## Presence

### presence_update (Client -> Server)

```json
{ "type": "presence_update", "payload": { "status": "online" } }
```

Valid values: `"online"`, `"idle"`, `"dnd"`, `"offline"`. Rate limited: 1 per 10 seconds.

### presence (Server -> Client, broadcast)

```json
{
  "seq": 50,
  "type": "presence",
  "payload": {
    "user_id": 1,
    "status": "online"
  }
}
```

---

## Channel Focus

### channel_focus (Client -> Server)

```json
{ "type": "channel_focus", "payload": { "channel_id": 5 } }
```

Tells the server which channel the user is currently viewing. Affects broadcast delivery and unread tracking.

---

## Channel Updates

All channel update messages are broadcast to all connected clients. Triggered by REST API calls from admins.

### channel_create (Server -> Client, broadcast)

```json
{
  "seq": 60,
  "type": "channel_create",
  "payload": {
    "id": 8,
    "name": "gaming",
    "type": "text",
    "category": "Hangout",
    "topic": "",
    "position": 3
  }
}
```

### channel_update (Server -> Client, broadcast)

Full channel object (all fields).

### channel_delete (Server -> Client, broadcast)

```json
{
  "seq": 62,
  "type": "channel_delete",
  "payload": { "id": 8 }
}
```

---

## Member Updates

All member messages are broadcast to all connected clients.

### member_join (Server -> Client, broadcast)

Sent when a user first connects (fresh connection, not reconnect replay).

```json
{
  "seq": 70,
  "type": "member_join",
  "payload": {
    "user": {
      "id": 5,
      "username": "newuser",
      "avatar": null,
      "role": "member"
    }
  }
}
```

### member_update (Server -> Client, broadcast)

Triggered when an admin changes a user's role.

```json
{
  "seq": 71,
  "type": "member_update",
  "payload": {
    "user_id": 5,
    "role": "moderator"
  }
}
```

### member_ban (Server -> Client, broadcast)

```json
{
  "seq": 72,
  "type": "member_ban",
  "payload": { "user_id": 5 }
}
```

### user_update (Server -> Client, broadcast)

Broadcast when a user changes their own profile via `PATCH /api/v1/users/me`
(username and/or avatar).

```json
{
  "seq": 73,
  "type": "user_update",
  "payload": {
    "user_id": 5,
    "username": "newname",
    "avatar": "uuid.png"
  }
}
```

`avatar` may be `null` when unset.

### member_leave (reserved)

`member_leave` is a defined message type that the server does not currently
emit (clients handle it defensively). Reserved for future member-removal
flows.

---

## Voice Signaling

Voice uses LiveKit as the SFU. WebSocket messages handle signaling (join/leave/state) while the actual audio/video flows through LiveKit's own WebSocket connection.

### voice_join (Client -> Server)

```json
{ "type": "voice_join", "payload": { "channel_id": 10 } }
```

On success, server sends (in order):
1. `voice_token` -- LiveKit JWT + URL
2. `voice_state` broadcast -- joiner's state to all clients
3. Existing `voice_state` messages -- one per existing participant (to joiner only)
4. `voice_config` -- channel audio settings (to joiner only)

### voice_token (Server -> Client, direct)

```json
{
  "type": "voice_token",
  "payload": {
    "channel_id": 10,
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "url": "/livekit",
    "direct_url": "ws://localhost:7880",
    "is_key_holder": false
  }
}
```

`is_key_holder` tells the joiner whether they are the channel's E2EE key
holder (see [Voice End-to-End Encryption](#voice-end-to-end-encryption)).
Tokens are 5-minute scoped JWTs whose publish sources (mic/camera/screen) are
restricted by the user's permissions.

### voice_config (Server -> Client, direct)

```json
{
  "type": "voice_config",
  "payload": {
    "channel_id": 10,
    "quality": "medium",
    "bitrate": 64000,
    "max_users": 50,
    "threshold_mode": "top_speakers",
    "mixing_threshold": 0,
    "top_speakers": 5
  }
}
```

Quality presets:

| Preset | Bitrate |
|--------|---------|
| `low` | 32,000 bps |
| `medium` | 64,000 bps |
| `high` | 128,000 bps |

### voice_leave (Client -> Server)

```json
{ "type": "voice_leave", "payload": {} }
```

### voice_leave (Server -> Client, broadcast)

```json
{
  "seq": 80,
  "type": "voice_leave",
  "payload": {
    "channel_id": 10,
    "user_id": 1
  }
}
```

### voice_speakers (reserved)

`voice_speakers` (`{ channel_id, speakers: [user_id, ...], threshold_mode }`)
is a defined message type that the server does not currently emit; clients
already handle it. Reserved for active-speaker signaling.

### voice_state (Server -> Client, broadcast)

```json
{
  "seq": 81,
  "type": "voice_state",
  "payload": {
    "channel_id": 10,
    "user_id": 1,
    "username": "alex",
    "muted": false,
    "deafened": false,
    "speaking": false,
    "camera": false,
    "screenshare": false
  }
}
```

### voice_mute / voice_deafen (Client -> Server)

```json
{ "type": "voice_mute", "payload": { "muted": true } }
{ "type": "voice_deafen", "payload": { "deafened": true } }
```

### voice_camera (Client -> Server)

```json
{ "type": "voice_camera", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `USE_VIDEO` permission.

### voice_screenshare (Client -> Server)

```json
{ "type": "voice_screenshare", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `SHARE_SCREEN` permission.

### voice_token_refresh (Client -> Server)

```json
{ "type": "voice_token_refresh", "payload": {} }
```

Rate limited: 1 per 60 seconds. Must be in a voice channel.

---

## Voice End-to-End Encryption

Voice/video media can be end-to-end encrypted. The server never holds the room
key — it only relays the ECDH key exchange between participants and tracks who
the **key holder** is (deterministically, the participant with the lowest user
ID in the channel). The joiner learns whether they are the key holder from
`voice_token.is_key_holder`. When a participant leaves, the key holder rotates
the room key so departed members cannot decrypt future media.

Both E2EE message types are rate limited at 5 per second per user. Key
material must be standard-alphabet base64 (padded or unpadded).

### voice_e2ee_announce (Client -> Server)

Announce this participant's ECDH public key to the channel.

```json
{ "type": "voice_e2ee_announce", "payload": { "public_key": "base64-ecdh-pubkey" } }
```

### voice_e2ee_announce (Server -> Client, broadcast to voice channel)

Relayed to the other participants with the sender's user ID attached:

```json
{
  "type": "voice_e2ee_announce",
  "payload": {
    "user_id": 1,
    "public_key": "base64-ecdh-pubkey"
  }
}
```

### voice_e2ee_offer (Client -> Server)

The key holder wraps the room key for a specific participant:

```json
{
  "type": "voice_e2ee_offer",
  "payload": {
    "target_user_id": 2,
    "encrypted_key": "base64-wrapped-room-key",
    "iv": "base64-iv"
  }
}
```

### voice_e2ee_offer (Server -> Client, relay to target)

Delivered only to `target_user_id`, with the sender attached:

```json
{
  "type": "voice_e2ee_offer",
  "payload": {
    "from_user_id": 1,
    "encrypted_key": "base64-wrapped-room-key",
    "iv": "base64-iv"
  }
}
```

---

## Direct Messages

### dm_channel_open (Server -> Client)

Sent when a DM is opened, created, or auto-reopened by an incoming message.

```json
{
  "type": "dm_channel_open",
  "payload": {
    "channel_id": 100,
    "recipient": {
      "id": 2,
      "username": "jordan",
      "avatar": "uuid.png",
      "status": "online"
    }
  }
}
```

### dm_channel_close (Server -> Client)

```json
{
  "type": "dm_channel_close",
  "payload": { "channel_id": 100 }
}
```

### DM Authorization

All handlers that touch a channel check the channel type and branch to participant-based authorization for DMs instead of role-based permissions. This applies to: `chat_send`, `chat_edit`, `chat_delete`, `reaction_add`/`remove`, `typing_start`, `channel_focus`.

---

## Server Restart

### server_restart (Server -> Client, broadcast)

```json
{
  "seq": 100,
  "type": "server_restart",
  "payload": {
    "reason": "update",
    "delay_seconds": 5
  }
}
```

---

## Error Handling

### error (Server -> Client)

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

### Error Codes

| Code | Description |
|------|-------------|
| `BAD_REQUEST` | Invalid payload format or field values |
| `INTERNAL` | Server-side error |
| `NOT_FOUND` | Channel or message not found |
| `FORBIDDEN` | Missing required permission |
| `RATE_LIMITED` | Too many requests (includes `retry_after` in seconds) |
| `ALREADY_JOINED` | Already in this voice channel |
| `CHANNEL_FULL` | Voice channel at capacity |
| `VOICE_ERROR` | Voice-specific error |
| `VIDEO_LIMIT` | Maximum video streams reached |
| `BANNED` | User is banned |
| `INVALID_JSON` | Message is not valid JSON |
| `UNKNOWN_TYPE` | Unrecognized message type |
| `SLOW_MODE` | Channel has slow mode enabled |
| `CONFLICT` | Duplicate reaction or constraint violation |

After 10 consecutive invalid JSON messages, the connection is forcibly closed.

---

## Rate Limits

All rate limits are enforced server-side using a token bucket rate limiter.

| Action | Limit | Window | Error Response |
|--------|-------|--------|----------------|
| Chat send | 10 | 1 second | `RATE_LIMITED` error |
| Chat edit | 10 | 1 second | `RATE_LIMITED` error |
| Chat delete | 10 | 1 second | `RATE_LIMITED` error |
| Typing | 1 | 3 seconds | Silently dropped |
| Presence | 1 | 10 seconds | `RATE_LIMITED` error |
| Reactions | 5 | 1 second | `RATE_LIMITED` error |
| Voice camera | 2 | 1 second | `RATE_LIMITED` error |
| Voice screenshare | 2 | 1 second | `RATE_LIMITED` error |
| Voice token refresh | 1 | 60 seconds | `RATE_LIMITED` error |
| Voice E2EE announce/offer | 5 | 1 second | `RATE_LIMITED` error |

---

## Message Type Reference Table

The authoritative type inventory is [protocol-schema.json](protocol-schema.json),
from which the Go and TypeScript constant files are generated
(`make protocol-generate` / verified in CI by `make protocol-verify`). The
tables below add per-type behavioral notes.

### Client -> Server (19 types)

| Type | Rate Limit | Notes |
|------|-----------|-------|
| `auth` | N/A (first message) | Token + optional last_seq |
| `chat_send` | 10/sec | + slow mode per channel |
| `chat_edit` | 10/sec | Own messages only |
| `chat_delete` | 10/sec | Own or mod (non-DM) |
| `reaction_add` | 5/sec | |
| `reaction_remove` | 5/sec | |
| `typing_start` | 1/3sec/channel | Silently dropped |
| `channel_focus` | None | Updates read state |
| `presence_update` | 1/10sec | |
| `voice_join` | None | |
| `voice_leave` | None | Empty payload |
| `voice_mute` | None | |
| `voice_deafen` | None | |
| `voice_camera` | 2/sec | Requires USE_VIDEO |
| `voice_screenshare` | 2/sec | Requires SHARE_SCREEN |
| `voice_token_refresh` | 1/60sec | Must be in voice |
| `voice_e2ee_announce` | 5/sec | ECDH pubkey announce |
| `voice_e2ee_offer` | 5/sec | Wrapped room key to target |
| `ping` | None | Heartbeat |

### Server -> Client (30 types)

| Type | Has seq? | Delivery |
|------|----------|----------|
| `auth_ok` | No | Direct |
| `auth_error` | No | Direct (then close) |
| `ready` | No | Direct |
| `chat_message` | Non-DM only | Channel or DM participants |
| `chat_send_ok` | No | Direct to sender |
| `chat_edited` | Non-DM only | Channel or DM participants |
| `chat_deleted` | Non-DM only | Channel or DM participants |
| `reaction_update` | Non-DM only | Channel or DM participants |
| `typing` | No | Channel (excl. sender) or DM |
| `presence` | Yes | All clients |
| `channel_create` | Yes | All clients |
| `channel_update` | Yes | All clients |
| `channel_delete` | Yes | All clients |
| `voice_state` | Yes | All clients |
| `voice_leave` | Yes | All clients |
| `voice_config` | No | Direct to joiner |
| `voice_token` | No | Direct to joiner |
| `voice_speakers` | No | Reserved — not currently emitted |
| `member_join` | Yes | All clients |
| `member_leave` | Yes | Reserved — not currently emitted |
| `member_update` | Yes | All clients |
| `user_update` | Yes | All clients (profile changes) |
| `member_ban` | Yes | All clients |
| `dm_channel_open` | No | Direct to participant |
| `dm_channel_close` | No | Direct to participant |
| `voice_e2ee_announce` | No | Voice channel (excl. sender) |
| `voice_e2ee_offer` | No | Direct to target participant |
| `server_restart` | Yes | All clients |
| `error` | No | Direct to requester |
| `pong` | No | Direct to pinger |
